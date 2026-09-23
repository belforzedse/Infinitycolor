import { Strapi } from "@strapi/strapi";
import { releaseOrderReservation } from "../../../../utils/stockReservations";
import { closeGroupIfAbandoned } from "../../../reserve-group/lib/reserve-group";
import { formatCancellationReasonForSms } from "../../../../services/sms/notifications";

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
  options: {
    createAuditLogs?: boolean;
    reservationStatus?: "Released" | "Expired";
    orderData?: Record<string, unknown>;
    contractData?: Record<string, unknown>;
    contractTransactionId?: number;
    contractTransactionData?: Record<string, unknown>;
    cancellationReasonCode?: string;
  } = {}
) => {
  const logContext = {
    orderId,
    contractId,
    userId,
    ...(reason ? { reason } : {}),
  };
  const createAuditLogs = options.createAuditLogs === true;
  const performedBy = Number.isFinite(Number(userId)) ? Number(userId) : undefined;
  const previous = await strapi.db.transaction(async ({ trx }) => {
    const [currentOrder, currentContract] = await Promise.all([
      strapi.db.query("api::order.order").findOne({
        where: { id: orderId },
        select: ["id", "Status"],
        transacting: trx,
      } as any),
      strapi.db.query("api::contract.contract").findOne({
        where: { id: contractId },
        select: ["id", "Status"],
        transacting: trx,
      } as any),
    ]);

    if (!currentOrder) throw new Error("ORDER_NOT_FOUND_DURING_CANCELLATION");
    if (!currentContract) throw new Error("CONTRACT_NOT_FOUND_DURING_CANCELLATION");

    // Release stock and the limited-coupon claim before changing the order status.
    // The discount helper intentionally refuses to release a settled order.
    await releaseOrderReservation(
      strapi as any,
      Number(orderId),
      options.reservationStatus ?? "Released",
      trx,
      { userId },
    );

    await strapi.db.query("api::order.order").update({
      where: { id: orderId },
      data: {
        ...options.orderData,
        Status: "Cancelled",
        // Deliberately never the raw `reason` param here: some callers (Saman/
        // Mellat/ZarinPal) source it from unauthenticated vendor callback text,
        // which must never reach the customer-facing reason verbatim.
        CancellationReason: formatCancellationReasonForSms(
          undefined,
          options.cancellationReasonCode ?? "payment_gateway_declined",
        ),
      },
      transacting: trx,
    } as any);
    await strapi.db.query("api::contract.contract").update({
      where: { id: contractId },
      data: { ...options.contractData, Status: "Cancelled" },
      transacting: trx,
    } as any);
    if (options.contractTransactionId) {
      await strapi.db.query("api::contract-transaction.contract-transaction").update({
        where: { id: options.contractTransactionId },
        data: options.contractTransactionData ?? { Status: "Failed" },
        transacting: trx,
      } as any);
    }

    return {
      orderStatus: String(currentOrder.Status || ""),
      contractStatus: String(currentContract.Status || ""),
    };
  });

  // A failed or abandoned first payment must not leave a reserve window behind:
  // an unpaid group would otherwise keep occupying the customer's single
  // consolidation slot until its deadline lapsed.
  try {
    const cancelled: any = await strapi.db.query("api::order.order").findOne({
      where: { id: orderId },
      populate: { reserve_shipment: true },
    } as any);
    const groupId = cancelled?.reserve_shipment?.id;
    if (groupId) await closeGroupIfAbandoned(strapi, Number(groupId));
  } catch (groupError) {
    strapi.log.error("Failed to close abandoned reserve group after gateway cancel", {
      ...logContext,
      error: groupError instanceof Error ? groupError.message : String(groupError),
    });
  }

  if (!createAuditLogs) return;

  const timestamp = new Date().toISOString();
  const writeAudit = async (kind: "order" | "contract") => {
    const fromStatus = kind === "order" ? previous.orderStatus : previous.contractStatus;
    const descriptionPrefix = kind === "order" ? "Order" : "Contract";
    const logData: any = {
      order: orderId,
      Action: "Update",
      Description:
        reason === "payment_gateway_failure"
          ? `${descriptionPrefix} status changed to Cancelled due to payment gateway failure`
          : reason === "wallet_payment_failed"
            ? `${descriptionPrefix} status changed to Cancelled due to wallet payment failure`
            : `${descriptionPrefix} status changed to Cancelled${reason ? ` (${reason})` : ""}`,
      Changes: {
        fromStatus,
        toStatus: "Cancelled",
        orderId,
        ...(kind === "contract" ? { contractId } : {}),
        userId,
        timestamp,
        reason,
      },
    };
    if (performedBy !== undefined) logData.performed_by = performedBy;
    await strapi.entityService.create("api::order-log.order-log", { data: logData });
  };

  for (const kind of ["order", "contract"] as const) {
    try {
      await writeAudit(kind);
    } catch (error) {
      strapi.log.error(`Failed to create ${kind} cancellation audit log`, {
        ...logContext,
        error: (error as Error)?.message || error,
      });
    }
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
  /**
   * What the bank is asked to charge, in toman. This is the *gateway leg* of
   * the order: with no wallet tender it equals the contract amount, and with a
   * wallet tender it is the remainder. Defaults to the contract amount so every
   * existing caller keeps its exact behaviour.
   */
  amountToman?: number;
};

export const requestSamanPayment = async (
  strapi: Strapi,
  params: SamanRequestParams
) => {
  const saman = strapi.service("api::payment-gateway.saman-kish") as any;
  const amountToman = Math.round(
    params.amountToman != null ? params.amountToman : params.contract?.Amount || 0,
  );
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
      redirectMethod: "POST" as const,
      formFields: { Token: String(paymentResult.token) },
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
  /** Gateway leg in toman; defaults to the whole contract amount. */
  amountToman?: number;
};

export const requestZarinPalPayment = async (
  strapi: Strapi,
  params: ZarinPalRequestParams
) => {
  const amountToman = Math.round(
    Number(params.amountToman != null ? params.amountToman : params.contract?.Amount || 0),
  );
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
      hasAuthority: Boolean(paymentResult.authority),
      error: (error as Error)?.message || error,
    });
  }

  if (!transactionCreated) {
    // ZarinPal has already minted an authority: the customer can still be sent
    // to it, and a payment against it would be real. Losing our own record of it
    // is therefore an *unknown* outcome, not a failure — cancelling the order
    // and releasing the money here would leave a payable authority pointing at a
    // cancelled order.
    return {
      paymentResult: {
        success: false,
        ambiguous: true,
        errorCode: "ZARINPAL_TOKEN_PERSISTENCE_FAILED",
        error: "Failed to persist ZarinPal payment request",
        requestId: paymentResult.requestId,
        authority: paymentResult.authority,
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

/**
 * Did the provider actually answer?
 *
 * "Initiation failed" and "we do not know whether initiation happened" are
 * different facts with different consequences. A gateway that answered with an
 * error code is proof that no payment exists, so the order can be cancelled and
 * the customer's wallet credit and stock released immediately. A transport
 * timeout, a dropped response, or a token we failed to persist proves nothing:
 * cancelling on that evidence risks releasing credit for a payment that is
 * about to complete. Those are recorded as `Unknown` for reconciliation, and the
 * reservation (with its wallet hold) is left to expire on its own clock.
 */
export type GatewayInitiationOutcome = {
  outcome: "failed" | "unknown";
  errorCode: string;
};

export const classifyGatewayInitiationOutcome = (
  paymentResult: any,
): GatewayInitiationOutcome => {
  if (paymentResult?.ambiguous === true) {
    return {
      outcome: "unknown",
      errorCode: String(paymentResult.errorCode || "PAYMENT_INITIATION_UNKNOWN"),
    };
  }

  // Mellat answers with `resCode`; ZarinPal with a numeric `code`. Either is a
  // provider verdict.
  const providerCode = Number(paymentResult?.resCode ?? paymentResult?.code);
  if (Number.isFinite(providerCode)) {
    return { outcome: "failed", errorCode: `PROVIDER_${providerCode}` };
  }

  // An HTTP status in the 4xx range is the provider rejecting the request. 5xx
  // and "no response at all" are not verdicts.
  const httpStatus = Number(paymentResult?.detailedError?.status);
  if (Number.isFinite(httpStatus) && httpStatus >= 400 && httpStatus < 500) {
    return { outcome: "failed", errorCode: `PROVIDER_HTTP_${httpStatus}` };
  }

  return {
    outcome: "unknown",
    errorCode: String(paymentResult?.errorCode || "PAYMENT_INITIATION_UNKNOWN"),
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
