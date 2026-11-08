import { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";

export const shippingOptionsHandler = (strapi: Strapi) => async (ctx: any) => {
  const { addressId, addressPayload } = ctx.request.body || {};

  try {
    const userId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!userId) return;

    const bale = ctx.state?.baleCheckoutScope;
    const shippingService = strapi.service("api::shipping.shipping");
    const methods = await shippingService.getAvailableMethodsForCart(
      userId,
      { addressId, addressPayload },
      ...(bale ? [{ cart: bale.cart }] : []),
    );

    return {
      data: {
        success: true,
        methods,
      },
    };
  } catch (error: any) {
    strapi.log.error("Failed to calculate shipping options", {
      message: error?.message,
      userId: ctx.state?.user?.id,
      body: ctx.request.body,
    });
    return ctx.badRequest("Shipping options could not be calculated", {
      data: {
        success: false,
        errorCode: error?.message || "SHIPPING_OPTIONS_FAILED",
      },
    });
  }
};
