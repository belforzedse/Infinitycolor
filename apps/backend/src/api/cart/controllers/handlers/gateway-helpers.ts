import { Strapi } from "@strapi/strapi";
import { releaseOrderReservation } from "../../../../utils/stockReservations";

type FinancialSummary = {
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  total: number;
};

const normalizeCellForSaman = (rawPhone?: string): string | undefined => {
  if (!rawPhone) return undefined;
  const digits = String(rawPhone).replace(/\D/g, "");
  if (!digits) return undefined;
  let normalized = digits;
  if (normalized.startsWith("0098") && normalized.length >= 14) {
    normalized = `0${normalized.slice(4)}`;
  } else if (normalized.startsWith("98") && normalized.length >= 12) {
    normalized = `0${normalized.slice(2)}`;
  } else if (!normalized.startsWith("0") && normalized.length === 10) {
    normalized = `0${normalized}`;
  }
  if (/^0\d{10}$/.test(normalized)) {
    return normalized;
  }
  return undefined;
};

export const cancelOrderAndRelease = async (
  strapi: Strapi,
  orderId: number,
  contractId: number,
  userId?: number | string,
  reason?: string,
  options: { createAuditLogs?: boolean } = {}
) => {
  const logContext = {
    orderId,
    contractId,
    userId,
    ...(reason ? { reason } : {}),
  };
  const createAuditLogs = options.createAuditLogs === true;
  const performedBy = Number.isFinite(Number(userId)) ? Number(userId) : undefined;

  let orderFromStatus: string | undefined;
  if (createAuditLogs) {
    try {
      const currentOrder = await strapi.entityService.findOne(
        "api::order.order",
        orderId,
        { fields: ["Status"] }
      );
      orderFromStatus = currentOrder?.Status;
    } catch (error) {
      strapi.log.error("Failed to fetch current order status", {
        ...logContext,
        error: (error as Error)?.message || error,
      });
    }
  }

  let orderUpdated = false;
  try {
    await strapi.entityService.update("api::order.order", orderId, {
      data: { Status: "Cancelled" },
    });
    orderUpdated = true;
  } catch (error) {
    strapi.log.error("Failed to update order Status", {
      ...logContext,
      error: (error as Error).message,
    });
  }

  if (createAuditLogs && orderUpdated) {
    try {
      const orderLogData: any = {
        order: orderId,
        Action: "Update",
        Description:
          reason === "payment_gateway_failure"
            ? "Order status changed to Cancelled due to payment gateway failure"
            : reason === "wallet_payment_failed"
            ? "Order status changed to Cancelled due to wallet payment failure"
            : `Order status changed to Cancelled${reason ? ` (${reason})` : ""}`,
        Changes: {
          fromStatus: orderFromStatus,
          toStatus: "Cancelled",
          orderId,
          userId,
          timestamp: new Date().toISOString(),
          reason,
        },
      };
      if (performedBy !== undefined) {
        orderLogData.performed_by = performedBy;
      }
      await strapi.entityService.create("api::order-log.order-log", {
        data: orderLogData,
      });
      strapi.log.info("Order status changed to Cancelled", {
        orderId,
        userId,
        fromStatus: orderFromStatus,
        toStatus: "Cancelled",
      });
    } catch (error) {
      strapi.log.error("Failed to create order-log for order status change", {
        ...logContext,
        error: (error as Error)?.message || error,
      });
    }
  }

  let contractFromStatus: string | undefined;
  if (createAuditLogs) {
    try {
      const currentContract = await strapi.entityService.findOne(
        "api::contract.contract",
        contractId,
        { fields: ["Status"] }
      );
      contractFromStatus = currentContract?.Status;
    } catch (error) {
      strapi.log.error("Failed to fetch current contract status", {
        ...logContext,
        error: (error as Error)?.message || error,
      });
    }
  }

  let contractUpdated = false;
  try {
    await strapi.entityService.update("api::contract.contract", contractId, {
      data: { Status: "Cancelled" },
    });
    contractUpdated = true;
  } catch (error) {
    strapi.log.error("Failed to update contract Status", {
      ...logContext,
      error: (error as Error).message,
    });
  }

  if (createAuditLogs && contractUpdated) {
    try {
      const contractLogData: any = {
        order: orderId,
        Action: "Update",
        Description:
          reason === "payment_gateway_failure"
            ? "Contract status changed to Cancelled due to payment gateway failure"
            : reason === "wallet_payment_failed"
            ? "Contract status changed to Cancelled due to wallet payment failure"
            : `Contract status changed to Cancelled${reason ? ` (${reason})` : ""}`,
        Changes: {
          fromStatus: contractFromStatus,
          toStatus: "Cancelled",
          orderId,
          contractId,
          userId,
          timestamp: new Date().toISOString(),
          reason,
        },
      };
      if (performedBy !== undefined) {
        contractLogData.performed_by = performedBy;
      }
      await strapi.entityService.create("api::order-log.order-log", {
        data: contractLogData,
      });
      strapi.log.info("Contract status changed to Cancelled", {
        orderId,
        contractId,
        userId,
        fromStatus: contractFromStatus,
        toStatus: "Cancelled",
      });
    } catch (error) {
      strapi.log.error("Failed to create order-log for contract status change", {
        ...logContext,
        error: (error as Error)?.message || error,
      });
    }
  }

  try {
    await releaseOrderReservation(
      strapi as any,
      Number(orderId),
      "Released",
      undefined,
      { userId }
    );
  } catch (error) {
    strapi.log.error("Failed to release order reservation", {
      ...logContext,
      error: (error as Error).message,
    });
  }
};

export const ensurePaymentGateway = async (
  strapi: Strapi,
  title: string,
  defaults: { Description?: string; IsActive?: boolean } = {}
) => {
  let gatewayEntity = (await strapi.entityService.findMany(
    "api::payment-gateway.payment-gateway",
    { filters: { Title: title }, limit: 1 }
  )) as any[];

  if (!gatewayEntity?.length) {
    const created = await strapi.entityService.create(
      "api::payment-gateway.payment-gateway",
      {
        data: {
          Title: title,
          IsActive: defaults.IsActive ?? true,
          Description: defaults.Description,
        },
      }
    );
    gatewayEntity = [created];
  }

  return gatewayEntity[0];
};

type SamanRequestParams = {
  order: any;
  contract: any;
  financialSummary: FinancialSummary;
  callbackURL?: string;
  userId: number;
  cellNumber?: string;
};

export const requestSamanPayment = async (
  strapi: Strapi,
  params: SamanRequestParams
) => {
  const saman = strapi.service("api::payment-gateway.saman-kish") as any;
  const amountToman = Math.round(params.contract?.Amount || 0);
  const amountIrr = amountToman * 10;

  const cellNumber =
    normalizeCellForSaman(params.cellNumber) ||
    normalizeCellForSaman(params.order?.delivery_address?.Phone) ||
    normalizeCellForSaman(
      params.order?.user?.Phone || params.order?.user?.user_info?.Phone
    );

  const paymentResult = await saman.requestPayment({
    orderId: params.order.id,
    amount: amountIrr,
    callbackURL: params.callbackURL,
    contractId: params.contract?.id,
    cellNumber,
  });

  if (!paymentResult?.success) {
    return { paymentResult };
  }

  const gatewayEntity = await ensurePaymentGateway(strapi, "Saman Kish", {
    Description: "Saman Electronic Payment (SEP)",
  });

  try {
    const discountIrr = Math.round(
      (params.financialSummary?.discount || 0) * 10
    );
    await strapi.entityService.create(
      "api::contract-transaction.contract-transaction",
      {
        data: {
          Type: "Gateway",
          Amount: amountIrr,
          DiscountAmount: discountIrr,
          Step: 1,
          Status: "Pending",
          TrackId: paymentResult.token,
          external_id: paymentResult.resNum || paymentResult.token,
          external_source: "SamanKish",
          contract: params.contract?.id,
          payment_gateway: gatewayEntity.id,
          Date: new Date(),
        },
      }
    );
  } catch (error) {
    strapi.log.error("Failed to create Saman contract-transaction", error);
  }

  try {
    if (params.contract?.id) {
      await strapi.entityService.update(
        "api::contract.contract",
        params.contract.id,
        {
          data: {
            Type: "Cash",
            external_source: "SamanKish",
            external_id: paymentResult.resNum || paymentResult.token,
          },
        }
      );
    }
  } catch (error) {
    strapi.log.error("Failed to update contract for Saman gateway", error);
  }

  try {
    await strapi.entityService.update("api::order.order", params.order.id, {
      data: {
        external_source: "SamanKish",
        external_id: paymentResult.resNum || paymentResult.token,
      },
    });
  } catch (error) {
    strapi.log.error("Failed to update order external source for Saman", error);
  }

  return {
    paymentResult: {
      success: true,
      refId: paymentResult.token,
      redirectUrl: paymentResult.redirectUrl,
      requestId: paymentResult.requestId,
      resNum: paymentResult.resNum,
    },
  };
};

type ZarinPalRequestParams = {
  order: any;
  contract: any;
  financialSummary: FinancialSummary;
  userId: number;
  mobile?: string;
  email?: string;
};

export const requestZarinPalPayment = async (
  strapi: Strapi,
  params: ZarinPalRequestParams
) => {
  const amountToman = Math.round(Number(params.contract?.Amount || 0));
  const amountIrr = amountToman * 10;

  if (!params.order?.id || !params.contract?.id || amountToman <= 0) {
    return {
      paymentResult: {
        success: false,
        error: "Invalid order or amount for ZarinPal payment",
        requestId: `ZPINVALID-${Date.now()}`,
      },
    };
  }

  const zarinpal = strapi.service("api::payment-gateway.zarinpal") as any;
  const paymentResult = await zarinpal.requestPayment({
    orderId: params.order.id,
    contractId: params.contract.id,
    amountToman,
    mobile: params.mobile,
    email: params.email,
  });

  if (!paymentResult?.success) {
    return { paymentResult };
  }

  const gatewayEntity = await ensurePaymentGateway(strapi, "ZarinPal", {
    Description: "ZarinPal payment gateway",
  });

  let transactionCreated = false;
  try {
    const discountIrr = Math.round(Number(params.financialSummary?.discount || 0) * 10);
    await strapi.entityService.create(
      "api::contract-transaction.contract-transaction",
      {
        data: {
          Type: "Gateway",
          Amount: amountIrr,
          DiscountAmount: discountIrr,
          Step: 1,
          Status: "Pending",
          TrackId: paymentResult.authority,
          GatewayAuthority: paymentResult.authority,
          GatewayStatus: "REQUESTED",
          GatewayResponse: paymentResult.gatewayResponse,
          external_id: paymentResult.authority,
          external_source: "ZarinPal",
          contract: params.contract.id,
          payment_gateway: gatewayEntity.id,
          Date: new Date(),
        } as any,
      }
    );
    transactionCreated = true;
  } catch (error) {
    strapi.log.error("Failed to create ZarinPal contract transaction", {
      orderId: params.order.id,
      contractId: params.contract.id,
      authority: paymentResult.authority,
      error: (error as Error)?.message || error,
    });
  }

  if (!transactionCreated) {
    return {
      paymentResult: {
        success: false,
        error: "Failed to persist ZarinPal payment request",
        requestId: paymentResult.requestId,
      },
    };
  }

  try {
    await strapi.entityService.update("api::contract.contract", params.contract.id, {
      data: {
        Type: "Cash",
        external_source: "ZarinPal",
        external_id: paymentResult.authority,
      },
    });
  } catch (error) {
    strapi.log.error("Failed to update contract for ZarinPal gateway", error);
  }

  try {
    await strapi.entityService.update("api::order.order", params.order.id, {
      data: {
        external_source: "ZarinPal",
        external_id: paymentResult.authority,
      },
    });
  } catch (error) {
    strapi.log.error("Failed to update order external source for ZarinPal", error);
  }

  return {
    paymentResult: {
      success: true,
      refId: paymentResult.authority,
      redirectUrl: paymentResult.redirectUrl,
      requestId: paymentResult.requestId,
      authority: paymentResult.authority,
    },
  };
};

export const requestMellatPayment = async (
  strapi: Strapi,
  params: {
    orderId: number;
    amount: number;
    userId: number;
    callbackURL?: string;
    contractId?: number;
  }
): Promise<any> => {
  const paymentService = strapi.service("api::payment-gateway.mellat-v3");
  return await paymentService.requestPayment({
    orderId: params.orderId,
    amount: params.amount,
    userId: params.userId,
    callbackURL: params.callbackURL,
    contractId: params.contractId,
  });
};
