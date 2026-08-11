import { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";

export const removeItemHandler = (strapi: Strapi) => async (ctx: any) => {
  const { id } = ctx.params;

  try {
    const userId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!userId) return;

    if (!id) {
      return ctx.badRequest("Cart item ID is required", {
        data: { success: false, error: "Cart item ID is required" },
      });
    }

    const cartItem = await strapi.db.query("api::cart-item.cart-item").findOne({
      where: { id, cart: { user: { id: userId } } },
    });

    if (!cartItem) {
      return ctx.forbidden(
        "You do not have permission to remove this cart item",
        {
          data: {
            success: false,
            error: "You do not have permission to remove this cart item",
          },
        }
      );
    }

    const cartService = strapi.service("api::cart.cart");
    const result = await cartService.removeCartItem(id, userId);
    if (!result.success) {
      return ctx.badRequest(result.message, {
        data: { success: false, error: result.message },
      });
    }

    return { data: { message: "Cart item removed successfully" } };
  } catch (error: any) {
    return ctx.badRequest(error.message, {
      data: { success: false, error: error.message },
    });
  }
};
