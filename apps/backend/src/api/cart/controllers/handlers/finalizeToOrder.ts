import { Strapi } from "@strapi/strapi";
import { fetchUserWithRole, resolveCustomerTargetUserId } from "../../../../utils/roles";
import {
  cancelOrderAndRelease,
  requestMellatPayment,
  requestSamanPayment,
  requestZarinPalPayment,
} from "./gateway-helpers";
import {
  isCheckoutGatewayEnabled,
  normalizeCheckoutGatewayCode,
} from "../../../payment-gateway/services/checkout-gateway-availability";
import { redactSensitive } from "../../../../utils/redactSensitive";
import {
  claimPaymentAttemptForInitiation,
  findPaymentAttempt,
  paymentAttemptResponse,
  updatePaymentAttempt,
} from "../../../payment-attempt/services/payment-attempt";
import { settleOrderWithWallet } from "./wallet-settlement";
import { consumeCheckoutCartLinesSafely } from "../../services/lib/order-cart-cleanup";
import {
  findAttachableGroup,
  findOpenGroupForUser,
  hasPaidMember,
} from "../../../reserve-group/lib/reserve-group";

export const finalizeToOrderHandler = (strapi: Strapi) => async (ctx: any) => {
  const {
    shipping,
    description,
    note,
    callbackURL,
    addressId,
    addressPayload,
    gateway,
    mobile,
    discountCode,
    reserveShipping,
    reserveGroupId,
    attemptId,
    quoteHash,
    analyticsCorrelationId,
  } = ctx.request.body;

  // The browser correlation id is opaque and never used for authorization. It
  // is persisted only to join a later server-side settlement event with the
  // storefront guest session. Reject control characters/URLs and keep the
  // bounded size expected by the analytics outbox.
  const rawAnalyticsCorrelationId = String(analyticsCorrelationId || "").trim();
  const normalizedAnalyticsCorrelationId = /^[A-Za-z0-9_-]{1,64}$/.test(rawAnalyticsCorrelationId)
    ? rawAnalyticsCorrelationId
    : undefined;

  let user = ctx.state.user;
  try {
    const targetUserId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!targetUserId) return;
    if (Number(user?.id) !== targetUserId) {
      user = (await fetchUserWithRole(strapi, targetUserId)) || { id: targetUserId };
    }

    const requestedGateway = String(gateway || "mellat").toLowerCase();
    const selectedGateway = normalizeCheckoutGatewayCode(requestedGateway) || "mellat";
    const managesPaymentAttempt = true;
    const normalizedAttemptId = String(attemptId || "").trim();
    const normalizedQuoteHash = String(quoteHash || "").trim();

    if (managesPaymentAttempt) {
      const gatewayEnabled = await isCheckoutGatewayEnabled(strapi, selectedGateway);
      if (!gatewayEnabled) {
        return ctx.badRequest("درگاه پرداخت انتخاب‌شده غیرفعال است.", {
          data: {
            success: false,
            errorCode: "PAYMENT_GATEWAY_DISABLED",
            gateway: selectedGateway,
          },
        });
      }
    }

    let resolvedAddressId = addressId;
    let resolvedShippingId = shipping;
    let resolvedShippingCost = 0;
    let shippingSnapshot: { code?: string; title?: string } = {};
    let reserveOrderData: {
      reserveGroupId: string;
      reserveExpiresAt: Date | null;
      reserveGroupRowId: number;
      isMerge: true;
    } | null = null;

    // Attaching to an existing reserve shipment. The group row -- not the parent
    // order -- owns the destination and the shipping method, so the child simply
    // inherits it. Eligibility is re-checked here, server-side, against the group's
    // own state: a stale browser showing a live countdown cannot attach past the
    // deadline, and a group whose root was never paid for (or was cancelled) is
    // not attachable at all, which is what stops free-shipping children from
    // piling onto a parcel that will never ship.
    if (reserveGroupId && typeof reserveGroupId === "string" && reserveGroupId.trim()) {
      const group = await findAttachableGroup(strapi, user.id, reserveGroupId.trim());
      const rootPaid = group ? await hasPaidMember(strapi, group.id) : false;
      if (!group || !rootPaid) {
        return ctx.badRequest("سفارش رزروی معتبر یافت نشد یا منقضی شده است", {
          data: {
            success: false,
            errorCode: "RESERVE_NOT_FOUND",
            message: "سفارش رزروی معتبر یافت نشد یا منقضی شده است",
          },
        });
      }
      const groupShipping = (group as any).shipping;
      const groupAddress = (group as any).delivery_address;
      resolvedAddressId = groupAddress?.id ?? groupAddress;
      resolvedShippingId = groupShipping?.id ?? groupShipping;
      resolvedShippingCost = 0;
      shippingSnapshot = {
        code: group.ShippingMethodCode || groupShipping?.Code,
        title: group.ShippingMethodTitle || groupShipping?.Title,
      };
      reserveOrderData = {
        reserveGroupId: group.groupKey,
        reserveExpiresAt: group.expiresAt ? new Date(group.expiresAt) : null,
        reserveGroupRowId: group.id,
        isMerge: true,
      };
    }

    // One consolidation window per customer. Checked here, before the gateway, and
    // not at settlement: activation runs inside the payment-settlement transaction,
    // which also consumes the stock hold and marks the order paid -- it must never
    // fail for a reason we could have caught while the customer was still on the
    // checkout page. The partial unique index only ever backstops a genuine race.
    if (!reserveOrderData && reserveShipping) {
      const existingOpen = await findOpenGroupForUser(strapi, user.id);
      if (existingOpen) {
        return ctx.badRequest("شما یک سفارش رزروی فعال دارید", {
          data: {
            success: false,
            errorCode: "RESERVE_ALREADY_ACTIVE",
            message:
              "شما یک سفارش رزروی فعال دارید. این سفارش را به آن اضافه کنید یا ارسال جداگانه را انتخاب کنید.",
            reserveGroupId: existingOpen.groupKey,
          },
        });
      }
    }

    // Validate required shipping information (skip when merging - we have it from parent)
    if (!reserveOrderData && !resolvedShippingId) {
      return ctx.badRequest("روش ارسال الزامی است", {
        data: {
          success: false,
          errorCode: "SHIPPING_REQUIRED",
          message: "روش ارسال الزامی است",
        },
      });
    }

    // Validate address is provided (skip when merging - we have it from parent)
    if (!reserveOrderData && !resolvedAddressId && !addressPayload) {
      return ctx.badRequest("آدرس تحویل الزامی است", {
        data: {
          success: false,
          errorCode: "ADDRESS_REQUIRED",
          message: "آدرس تحویل الزامی است",
        },
      });
    }

    // Verify shipping method exists and is valid (skip when merging)
    if (!reserveOrderData) {
      try {
        const shippingMethod = await strapi.entityService.findOne(
          "api::shipping.shipping",
          resolvedShippingId,
        );
        if (!shippingMethod) {
          return ctx.badRequest("روش ارسال انتخاب شده معتبر نیست", {
            data: {
              success: false,
              errorCode: "INVALID_SHIPPING",
              message: "روش ارسال انتخاب شده معتبر نیست",
            },
          });
        }
      } catch (err) {
        strapi.log.error("Failed to validate shipping method:", err);
        return ctx.badRequest("خطا در بررسی روش ارسال", {
          data: {
            success: false,
            errorCode: "SHIPPING_VALIDATION_FAILED",
            message: "خطا در بررسی روش ارسال",
          },
        });
      }
    }

    // Handle inline address creation when provided (skip when merging)
    if (!reserveOrderData && !resolvedAddressId && addressPayload) {
      const { shipping_city, PostalCode, FullAddress, Description, save } = addressPayload;

      if (!shipping_city || !PostalCode || !FullAddress) {
        return ctx.badRequest("آدرس تحویل الزامی است", {
          data: {
            success: false,
            errorCode: "ADDRESS_REQUIRED",
            message: "آدرس تحویل الزامی است",
          },
        });
      }

      if (!/^\d{10}$/.test(String(PostalCode))) {
        return ctx.badRequest("کد پستی باید ۱۰ رقم باشد", {
          data: {
            success: false,
            errorCode: "INVALID_POSTAL_CODE",
            message: "کد پستی باید ۱۰ رقم باشد",
          },
        });
      }

      // Validate city exists
      const city = await strapi.entityService.findOne(
        "api::shipping-city.shipping-city",
        shipping_city,
        {
          populate: { shipping_province: true },
        },
      );

      if (!city) {
        return ctx.badRequest("شهر انتخاب شده معتبر نیست", {
          data: {
            success: false,
            errorCode: "INVALID_CITY",
            message: "شهر انتخاب شده معتبر نیست",
          },
        });
      }

      const addressData = {
        shipping_city,
        PostalCode: String(PostalCode),
        FullAddress: String(FullAddress),
        Description: Description || undefined,
        IsTemporary: !save,
        user: user.id,
      };

      try {
        const createdAddress = await strapi.entityService.create(
          "api::local-user-address.local-user-address",
          { data: addressData },
        );
        resolvedAddressId = createdAddress.id;
      } catch (err) {
        strapi.log.error("Failed to create inline address during finalize", err);
        return ctx.badRequest("خطا در ثبت آدرس", {
          data: {
            success: false,
            errorCode: "ADDRESS_CREATION_FAILED",
            message: "خطا در ثبت آدرس",
          },
        });
      }
    }

    // Verify address exists and belongs to user (skip when merging - parent address already validated)
    if (!reserveOrderData && resolvedAddressId) {
      try {
        const address = await strapi.entityService.findOne(
          "api::local-user-address.local-user-address",
          resolvedAddressId,
          { populate: { user: true, shipping_city: true } },
        );
        if (!address) {
          return ctx.badRequest("آدرس انتخاب شده یافت نشد", {
            data: {
              success: false,
              errorCode: "ADDRESS_NOT_FOUND",
              message: "آدرس انتخاب شده یافت نشد",
            },
          });
        }

        // Validate address ownership - critical security check
        const addressUserId =
          typeof address.user === "object" && address.user?.id
            ? address.user.id
            : typeof address.user === "number"
              ? address.user
              : null;

        if (!addressUserId || Number(addressUserId) !== Number(user.id)) {
          strapi.log.warn("Address ownership validation failed", {
            userId: user.id,
            addressId: resolvedAddressId,
            addressUserId,
            attempt: "unauthorized_address_access",
          });

          return ctx.badRequest("آدرس انتخاب شده متعلق به شما نیست", {
            data: {
              success: false,
              errorCode: "ADDRESS_UNAUTHORIZED",
              message: "آدرس انتخاب شده متعلق به شما نیست",
            },
          });
        }
      } catch (err) {
        strapi.log.error("Failed to validate address:", err);
        return ctx.badRequest("خطا در بررسی آدرس", {
          data: {
            success: false,
            errorCode: "ADDRESS_VALIDATION_FAILED",
            message: "خطا در بررسی آدرس",
          },
        });
      }
    }

    if (!reserveOrderData) {
      try {
        const shippingService = strapi.service("api::shipping.shipping");
        const calculatedShipping = await shippingService.calculateMethodForCart(
          user.id,
          resolvedShippingId,
          { addressId: resolvedAddressId },
        );
        resolvedShippingCost = Number(calculatedShipping.price || 0);
        shippingSnapshot = {
          code: calculatedShipping.code,
          title: calculatedShipping.title,
        };
      } catch (err: any) {
        strapi.log.warn("Shipping method validation failed during finalize", {
          userId: user.id,
          shippingId: resolvedShippingId,
          addressId: resolvedAddressId,
          error: err?.message || err,
        });
        return ctx.badRequest("Selected shipping method is not available", {
          data: {
            success: false,
            errorCode: err?.message || "INVALID_SHIPPING",
            message: "Selected shipping method is not available",
          },
        });
      }
    }

    if (managesPaymentAttempt) {
      if (!normalizedAttemptId || normalizedAttemptId.length > 128) {
        return ctx.badRequest("شناسه تلاش پرداخت الزامی است", {
          data: { success: false, errorCode: "CHECKOUT_ATTEMPT_REQUIRED" },
        });
      }
      if (!normalizedQuoteHash) {
        return ctx.badRequest("پیش‌فاکتور پرداخت الزامی است", {
          data: { success: false, errorCode: "CHECKOUT_QUOTE_REQUIRED" },
        });
      }
    }

    const shippingData: Record<string, unknown> = {
      shippingId: resolvedShippingId,
      shippingCost: resolvedShippingCost,
      shippingMethodCode: shippingSnapshot.code,
      shippingMethodTitle: shippingSnapshot.title,
      description,
      note,
      addressId: resolvedAddressId,
      discountCode,
      reserveShipping: !!reserveShipping,
      reserveGroupId: reserveGroupId || undefined,
      ...(managesPaymentAttempt
        ? {
            gateway: selectedGateway,
            attemptId: normalizedAttemptId,
            quoteHash: normalizedQuoteHash,
          }
        : {}),
      ...(normalizedAnalyticsCorrelationId
        ? { analyticsCorrelationId: normalizedAnalyticsCorrelationId }
        : {}),
    };
    if (reserveOrderData) {
      shippingData.reserveOrderData = reserveOrderData;
    }

    const cartService = strapi.service("api::cart.cart");
    const result = await cartService.finalizeCartToOrder(user.id, shippingData);

    if (!result.success) {
      if (result.status === 409) {
        return ctx.conflict(result.message, {
          data: {
            success: false,
            errorCode: result.errorCode,
            message: result.message,
            quote: result.quote,
          },
        });
      }
      return ctx.badRequest(result.message, {
        data: {
          success: false,
          errorCode: result.errorCode,
          message: result.message,
          itemsRemoved: result.itemsRemoved,
          itemsAdjusted: result.itemsAdjusted,
          cart: result.cart,
        },
      });
    }

    const order = result.order;
    const contract = result.contract;
    const financialSummary = result.financialSummary;
    const paymentAttempt = result.paymentAttempt;

    if (!paymentAttempt?.id) {
      return ctx.badRequest("رکورد تلاش پرداخت یافت نشد", {
        data: {
          success: false,
          errorCode: "PAYMENT_ATTEMPT_MISSING",
        },
      });
    }

    if (result.replayed && String(paymentAttempt.Status || "") !== "Created") {
      return { data: paymentAttemptResponse(paymentAttempt) };
    }

    let snappayCallbackNonce = String(result.snappayCallbackNonce || "");
    if (result.replayed && selectedGateway === "snappay" && !snappayCallbackNonce) {
      snappayCallbackNonce = String(paymentAttempt.callbackNonce || "");
      if (!snappayCallbackNonce) {
        await updatePaymentAttempt(strapi, Number(paymentAttempt.id), {
          Status: "Unknown",
          failureCode: "SNAPPAY_CALLBACK_NONCE_UNRECOVERABLE",
          failureMessage: "SnappPay callback correlation secret could not be recovered",
          nextAction: "manual_review",
        }).catch(() => undefined);
        ctx.status = 202;
        return {
          data: {
            success: false,
            message: "شروع پرداخت نیازمند بررسی است",
            errorCode: "PAYMENT_UNKNOWN",
            orderId: order.id,
            contractId: contract.id,
            attemptId: normalizedAttemptId,
            paymentStatus: "Unknown",
          },
        };
      }
    }

    let totalAmount = contract.Amount || 0;

    strapi.log.info(`Processing payment for Order ${order.id}:`, {
      orderId: order.id,
      contractId: contract.id,
      totalAmount,
      userId: user.id,
      callbackURL: callbackURL || "/orders/payment-callback",
    });

    if (!managesPaymentAttempt) {
      const gatewayEnabled = await isCheckoutGatewayEnabled(strapi, selectedGateway);
      if (!gatewayEnabled) {
        return ctx.badRequest("درگاه پرداخت انتخاب‌شده غیرفعال است.", {
          data: {
            success: false,
            errorCode: "PAYMENT_GATEWAY_DISABLED",
            gateway: selectedGateway,
          },
        });
      }
    }

    const paymentGatewayLabel =
      selectedGateway === "snappay"
        ? "SnappPay"
        : selectedGateway === "samankish"
          ? "SamanKish"
          : selectedGateway === "zarinpal"
            ? "ZarinPal"
            : selectedGateway === "wallet"
              ? "Wallet"
              : "Mellat";
    try {
      await strapi.entityService.update("api::order.order", order.id, {
        data: { PaymentGateway: paymentGatewayLabel },
      });
    } catch (e) {
      strapi.log.error("Failed to update order payment gateway", {
        orderId: order.id,
        gateway: paymentGatewayLabel,
        error: (e as Error)?.message || e,
      });
    }

    if (managesPaymentAttempt && selectedGateway !== "wallet") {
      const claimed = await claimPaymentAttemptForInitiation(strapi, Number(paymentAttempt.id));
      if (!claimed) {
        const currentAttempt = await findPaymentAttempt(
          strapi,
          Number(user.id),
          normalizedAttemptId,
        );
        return {
          data: paymentAttemptResponse(currentAttempt || paymentAttempt),
        };
      }
      paymentAttempt.Status = "Pending";
    }

    // Wallet settlement is one database transaction: debit, ledgers, stock,
    // order, contract, and durable attempt either all commit or all roll back.
    if (selectedGateway === "wallet") {
      try {
        const settlement = await settleOrderWithWallet(strapi, {
          userId: Number(user.id),
          orderId: Number(order.id),
          contractId: Number(contract.id),
          paymentAttemptId: Number(paymentAttempt.id),
          attemptId: normalizedAttemptId,
          totalToman: Number(financialSummary?.total || contract.Amount || 0),
          discountToman: Number(financialSummary?.discount || 0),
        });
        // Consume only the cart lines this order was built from. Wallet settlement has
        // already committed at this point, so a cleanup failure must not fail the
        // response — it stays durably pending for the reconcile sweep.
        await consumeCheckoutCartLinesSafely(strapi, Number(order.id), { gateway: "Wallet" });
        return {
          data: {
            success: true,
            message: "Order paid via wallet.",
            orderId: order.id,
            contractId: contract.id,
            redirectUrl: "",
            refId: settlement.reference,
            financialSummary,
            requestId: settlement.reference,
            attemptId: normalizedAttemptId,
            paymentStatus: "Succeeded",
            ...(order.reserveGroupId && { reserveGroupId: order.reserveGroupId }),
            ...(order.reserveExpiresAt && { reserveExpiresAt: order.reserveExpiresAt }),
          },
        };
      } catch (error: any) {
        const message = String(error?.message || "Wallet payment failed");
        await updatePaymentAttempt(strapi, Number(paymentAttempt.id), {
          Status: "Failed",
          failureCode: message.split(":")[0] || "WALLET_PAYMENT_FAILED",
          failureMessage: message,
          resolvedAt: new Date(),
        }).catch(() => undefined);
        await cancelOrderAndRelease(
          strapi,
          order.id,
          contract.id,
          user.id,
          "wallet_payment_failed",
          { createAuditLogs: true },
        );
        return ctx.badRequest("موجودی کیف پول کافی نیست یا پرداخت کامل نشد", {
          data: {
            success: false,
            errorCode: message.split(":")[0] || "WALLET_PAYMENT_FAILED",
            message,
            orderId: order.id,
            attemptId: normalizedAttemptId,
          },
        });
      }
    }

    let paymentResult: any = null;

    if (selectedGateway === "snappay") {
      const callbackNonce = snappayCallbackNonce;
      if (!callbackNonce) {
        await updatePaymentAttempt(strapi, Number(paymentAttempt.id), {
          Status: "Unknown",
          failureCode: "SNAPPAY_CALLBACK_NONCE_MISSING",
          failureMessage: "SnappPay initialization could not be resumed safely",
          nextAction: "manual_review",
        });
        ctx.status = 202;
        return {
          data: {
            success: false,
            message: "شروع پرداخت نیازمند بررسی است",
            errorCode: "PAYMENT_UNKNOWN",
            orderId: order.id,
            contractId: contract.id,
            attemptId: normalizedAttemptId,
            paymentStatus: "Unknown",
          },
        };
      }
      const initiation = await strapi
        .service("api::payment-gateway.snappay-orchestrator")
        .initiate({
          paymentAttemptId: Number(paymentAttempt.id),
          callbackNonce,
          mobile,
        });
      if (!initiation.success) {
        if (initiation.status === "Unknown") ctx.status = 202;
        return {
          data: {
            success: false,
            message: initiation.message || "شروع پرداخت اسنپ‌پی انجام نشد",
            errorCode:
              initiation.errorCode ||
              (initiation.status === "Unknown" ? "PAYMENT_UNKNOWN" : "PAYMENT_INITIATION_FAILED"),
            orderId: order.id,
            contractId: contract.id,
            attemptId: normalizedAttemptId,
            paymentStatus: initiation.status,
          },
        };
      }
      paymentResult = {
        success: true,
        refId: initiation.transactionId,
        requestId: initiation.transactionId,
        redirectUrl: initiation.redirectUrl,
      };
    } else if (selectedGateway === "samankish") {
      const { paymentResult: pr } = await requestSamanPayment(strapi, {
        order,
        contract,
        financialSummary,
        callbackURL: callbackURL,
        userId: user.id,
        cellNumber: mobile || user?.Phone,
      });
      paymentResult = pr;
    } else if (selectedGateway === "zarinpal") {
      const { paymentResult: pr } = await requestZarinPalPayment(strapi, {
        order,
        contract,
        financialSummary,
        userId: user.id,
        mobile: mobile || user?.Phone,
      });
      paymentResult = pr;
    } else {
      paymentResult = await requestMellatPayment(strapi, {
        orderId: order.id,
        // Contract amounts are stored in toman; mellat-v3 performs the single
        // required toman-to-rial conversion at the provider boundary.
        amount: totalAmount,
        userId: user.id,
        callbackURL: callbackURL,
        contractId: contract.id,
      });
    }

    strapi.log.info(`Payment result for Order ${order.id}:`, {
      success: paymentResult?.success,
      error: paymentResult?.error,
      requestId: paymentResult?.requestId,
      hasDetailedError: !!paymentResult?.detailedError,
    });

    if (!paymentResult || !paymentResult.success) {
      const reqId = paymentResult?.requestId;
      const errMsg = paymentResult?.error || "Payment gateway error";
      const detailed = paymentResult?.detailedError || {};
      if (managesPaymentAttempt && paymentAttempt?.id) {
        await updatePaymentAttempt(strapi, Number(paymentAttempt.id), {
          Status: "Failed",
          failureCode: "PAYMENT_INITIATION_FAILED",
          failureMessage: errMsg,
          providerResponse: detailed,
          resolvedAt: new Date(),
        });
      }
      try {
        await strapi.entityService.create("api::order-log.order-log", {
          data: {
            order: order.id,
            performed_by: user.id,
            Action: "Update",
            Description: "Gateway payment request failed",
            Changes: {
              requestId: reqId,
              error: errMsg,
              userId: user.id,
            },
          },
        });
      } catch (e) {
        strapi.log.error("Failed to write order-log for gateway failure", {
          orderId: order.id,
          userId: user.id,
          error: (e as Error)?.message || e,
        });
      }

      await cancelOrderAndRelease(
        strapi,
        order.id,
        contract.id,
        user.id,
        "payment_gateway_failure",
        { createAuditLogs: true },
      );

      return ctx.badRequest(errMsg, {
        data: {
          success: false,
          error: errMsg,
          debug: detailed,
          requestId: reqId,
          timestamp: new Date().toISOString(),
          orderId: order.id,
          contractId: contract.id,
        },
      });
    }

    strapi.log.info(`Payment successful for Order ${order.id}:`, {
      ...(selectedGateway === "snappay"
        ? { hasRedirectUrl: Boolean(paymentResult.redirectUrl) }
        : { redirectUrl: paymentResult.redirectUrl }),
      refId: paymentResult.refId,
    });

    if (managesPaymentAttempt && paymentAttempt?.id) {
      await updatePaymentAttempt(strapi, Number(paymentAttempt.id), {
        Status: "Redirected",
        providerReference: String(paymentResult.refId || paymentResult.requestId || ""),
        redirectUrl: paymentResult.redirectUrl,
        providerResponse: {
          requestId: paymentResult.requestId,
          refId: paymentResult.refId,
        },
        redirectedAt: new Date(),
      });
    }

    try {
      await strapi.entityService.create("api::order-log.order-log", {
        data: {
          order: order.id,
          Action: "Update",
          Description: `Gateway payment request initiated (${selectedGateway})`,
          Changes: {
            requestId: paymentResult.requestId,
            refId: paymentResult.refId,
            ...(selectedGateway === "snappay"
              ? { hasRedirectUrl: Boolean(paymentResult.redirectUrl) }
              : { redirectUrl: paymentResult.redirectUrl }),
          },
        },
      });
    } catch (e) {
      strapi.log.error("Failed to write order-log for gateway request", e);
    }

    // NOTE: Do not clear cart here. Cart will be cleared on gateway callback success.

    return {
      data: {
        success: true,
        message: "Order created successfully. Redirecting to payment gateway.",
        orderId: order.id,
        contractId: contract.id,
        redirectUrl: paymentResult.redirectUrl,
        refId: paymentResult.refId,
        financialSummary: financialSummary,
        requestId: paymentResult.requestId,
        ...(managesPaymentAttempt
          ? {
              attemptId: normalizedAttemptId,
              paymentStatus: "Redirected",
            }
          : {}),
        ...(order.reserveGroupId && { reserveGroupId: order.reserveGroupId }),
        ...(order.reserveExpiresAt && { reserveExpiresAt: order.reserveExpiresAt }),
      },
    };
  } catch (error: any) {
    strapi.log.error("Error in finalizeToOrder:", {
      message: error.message,
      stack: error.stack,
      userId: user?.id,
      requestBody: redactSensitive(ctx.request.body),
    });
    if (error?.status) {
      // Convert structured errors to ctx.badRequest() format per payment error guideline
      const errorCode =
        error?.payload?.data?.errorCode || error.errorCode || error.code || "PAYMENT_ERROR";
      const message =
        error?.payload?.data?.message || error.message || error.error || "خطا در پردازش درخواست";
      return ctx.badRequest(message, {
        data: {
          success: false,
          errorCode,
          message,
          timestamp: new Date().toISOString(),
          userId: user?.id,
        },
      });
    }
    return ctx.badRequest(error.message, {
      data: {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        userId: user?.id,
      },
    });
  }
};
