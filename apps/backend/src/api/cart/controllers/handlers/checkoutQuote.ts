import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";
import { createCheckoutQuote } from "../../services/lib/checkout-quote";
import {
  isCheckoutGatewayEnabled,
  normalizeCheckoutGatewayCode,
} from "../../../payment-gateway/services/checkout-gateway-availability";

export const checkoutQuoteHandler = (strapi: Strapi) => async (ctx: any) => {
  const {
    shipping,
    addressId,
    addressPayload,
    gateway,
    discountCode,
    reserveGroupId,
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
      const parent = await strapi.db.query("api::order.order").findOne({
        where: {
          user: { id: userId },
          reserveGroupId: String(reserveGroupId),
          isReserveOrder: true,
          reserveExpiresAt: { $gt: new Date().toISOString() },
        },
        populate: { shipping: true },
      });
      if (!parent) {
        return ctx.badRequest("سفارش رزروی معتبر یافت نشد یا منقضی شده است", {
          data: { success: false, errorCode: "RESERVE_NOT_FOUND" },
        });
      }
      shippingId = parent.shipping?.id ?? parent.shipping;
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

    const quote = await createCheckoutQuote(strapi, userId, {
      shippingId: Number(shippingId),
      shippingCost,
      discountCode,
      gateway: selectedGateway,
      reserveGroupId,
    });
    if (selectedGateway === "snappay") {
      await strapi
        .service("api::payment-gateway.snappay-orchestrator")
        .checkEligibility(Math.round(quote.financialSummary.total * 10));
    }
    ctx.body = { data: { success: true, ...quote } };
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
