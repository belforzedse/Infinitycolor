import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";
import { createCheckoutQuote } from "../../services/lib/checkout-quote";
import {
  isCheckoutGatewayEnabled,
  normalizeCheckoutGatewayCode,
} from "../../../payment-gateway/services/checkout-gateway-availability";
import {
  findAttachableGroup,
  hasPaidMember,
} from "../../../reserve-group/lib/reserve-group";
import { buildWalletCheckoutContext } from "../../services/lib/wallet-checkout";
import { PaymentAllocationError, tomanToIrr } from "../../services/lib/payment-allocation";

export const checkoutQuoteHandler = (strapi: Strapi) => async (ctx: any) => {
  const {
    shipping,
    addressId,
    addressPayload,
    gateway,
    discountCode,
    reserveGroupId,
    walletAmountToman,
    supersedeAttemptId,
  } = ctx.request.body || {};

  try {
    const userId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!userId) return;

    const selectedGateway = normalizeCheckoutGatewayCode(gateway);
    if (!selectedGateway || !(await isCheckoutGatewayEnabled(strapi, selectedGateway))) {
      return ctx.badRequest("درگاه پرداخت انتخاب‌شده غیرفعال است.", {
        data: { success: false, errorCode: "PAYMENT_GATEWAY_DISABLED" },
      });
    }

    let shippingId = shipping;
    let shippingCost = 0;
    if (reserveGroupId) {
      // Quoting an attach: shipping stays 0 and the method comes from the group,
      // never from the client. Same eligibility rules as finalize, so the quote a
      // shopper sees cannot disagree with what the server will accept.
      const group = await findAttachableGroup(strapi, userId, String(reserveGroupId));
      const rootPaid = group ? await hasPaidMember(strapi, group.id) : false;
      if (!group || !rootPaid) {
        return ctx.badRequest("سفارش رزروی معتبر یافت نشد یا منقضی شده است", {
          data: { success: false, errorCode: "RESERVE_NOT_FOUND" },
        });
      }
      const groupShipping = (group as any).shipping;
      shippingId = groupShipping?.id ?? groupShipping;
    } else {
      if (!shippingId) {
        return ctx.badRequest("روش ارسال الزامی است", {
          data: { success: false, errorCode: "SHIPPING_REQUIRED" },
        });
      }
      if (!addressId && !addressPayload) {
        return ctx.badRequest("آدرس تحویل الزامی است", {
          data: { success: false, errorCode: "ADDRESS_REQUIRED" },
        });
      }
      const method = await strapi.service("api::shipping.shipping").calculateMethodForCart(
        userId,
        shippingId,
        { addressId, addressPayload },
      );
      shippingCost = Number(method.price || 0);
    }

    // Built before the quote so the wallet split is part of the hashed quote,
    // and reported on every response so the storefront never has to infer a
    // capability from a field that happens to be missing.
    const walletContext = await buildWalletCheckoutContext(strapi, userId, {
      selectedGateway,
      requestedWalletAmount: walletAmountToman,
      supersedeAttemptId,
    });

    let quote;
    try {
      quote = await createCheckoutQuote(strapi, userId, {
        shippingId: Number(shippingId),
        shippingCost,
        discountCode,
        gateway: selectedGateway,
        reserveGroupId,
        resolveAllocation: walletContext.resolve,
      });
    } catch (allocationError: any) {
      if (!(allocationError instanceof PaymentAllocationError)) throw allocationError;
      return ctx.badRequest(allocationError.message, {
        data: {
          success: false,
          errorCode: allocationError.code,
          message: allocationError.message,
          paymentCapabilities: walletContext.capabilities,
          ...allocationError.details,
        },
      });
    }
    // SnappPay's own timeouts/rejections are a provider-availability problem, not
    // a defect in this cart's quote. Failing the whole request here meant one slow
    // gateway took down checkout for whoever happened to pick it — the quote,
    // totals, shipping and discount are all already computed and correct.
    //
    // Return them, and report the gateway as unavailable alongside, so the shopper
    // keeps their checkout and can switch gateway without recomputing anything.
    let snappayUnavailable: string | null = null;
    if (selectedGateway === "snappay") {
      try {
        // SnappPay only ever finances the gateway leg. With no wallet tender
        // this is the full total, exactly as before.
        await strapi
          .service("api::payment-gateway.snappay-orchestrator")
          .checkEligibility(
            tomanToIrr(
              quote.paymentAllocation?.gatewayToman ?? quote.financialSummary.total,
            ),
          );
      } catch (snappayError: any) {
        snappayUnavailable =
          String(snappayError?.message || "").split(":")[0] || "SNAPPAY_UNAVAILABLE";
        strapi.log.warn("SnappPay eligibility check failed during checkout quote", {
          reasonCode: snappayUnavailable,
        });
      }
    }
    ctx.body = {
      data: {
        success: true,
        ...quote,
        paymentCapabilities: walletContext.capabilities,
        ...(snappayUnavailable
          ? {
              gatewayAvailable: false,
              gatewayNotice: "پرداخت اقساطی اسنپ‌پی موقتاً در دسترس نیست.",
              gatewayErrorCode: "SNAPPAY_UNAVAILABLE",
            }
          : {}),
      },
    };
  } catch (error: any) {
    const [errorCode] = String(error?.message || "CHECKOUT_QUOTE_FAILED").split(":");
    return ctx.badRequest("امکان محاسبه مبلغ نهایی سفارش وجود ندارد", {
      data: {
        success: false,
        errorCode: errorCode || "CHECKOUT_QUOTE_FAILED",
        message: error?.message,
      },
    });
  }
};
