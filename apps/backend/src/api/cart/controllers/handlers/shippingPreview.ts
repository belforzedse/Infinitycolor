import { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";

export const shippingPreviewHandler = (strapi: Strapi) => async (ctx: any) => {
  const { shippingId, addressId, addressPayload } = ctx.request.body || {};

  try {
    const userId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!userId) return;

    const shippingService = strapi.service("api::shipping.shipping");
    if (shippingId) {
      const method = await shippingService.calculateMethodForCart(userId, shippingId, {
        addressId,
        addressPayload,
      });
      ctx.body = {
        success: true,
        shipping: method.price,
        method,
      };
      return;
    }

    const methods = await shippingService.getAvailableMethodsForCart(userId, {
      addressId,
      addressPayload,
    });
    ctx.body = {
      success: true,
      shipping: null,
      methods,
    };
  } catch (error: any) {
    return ctx.badRequest("Shipping preview could not be calculated", {
      data: {
        success: false,
        errorCode: error?.message || "SHIPPING_PREVIEW_FAILED",
      },
    });
  }
};

/*
function computeTotalWeight(cart: any): number {
  let total = 0;
  for (const item of cart?.cart_items || []) {
    const product = item?.product_variation?.product;
    const weight = Number(product?.Weight ?? 100) || 100;
    const count = Number(item?.Count || 0);
    total += weight * count;
  }
  return total > 0 ? total : 100;
}

// Previous implementation kept for reference but fully disabled:
// export const shippingPreviewHandler = (strapi: Strapi) => async (ctx: any) => {
//   ...
// };
*/
