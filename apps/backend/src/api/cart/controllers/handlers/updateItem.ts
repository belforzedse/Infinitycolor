import { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";
import { getAvailableStockCount } from "../../services/lib/stock";

export const updateItemHandler = (strapi: Strapi) => async (ctx: any) => {
  const { cartItemId, count } = ctx.request.body;

  try {
    const userId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!userId) return;

    if (!cartItemId) {
      return ctx.badRequest("Cart item ID is required", {
        data: { success: false, error: "Cart item ID is required" },
      });
    }

    // Ownership is resolved before branching on `count`. The zero-quantity branch
    // deletes a cart line, so it needs exactly the same authorization as an explicit
    // remove — checking it only on the update branch let any authenticated user delete
    // another customer's cart item by posting count: 0 with its id.
    const cartItem = await strapi.db.query("api::cart-item.cart-item").findOne({
      where: { id: cartItemId, cart: { user: { id: userId } } },
      populate: { product_variation: { populate: { product_stock: true } } },
    });

    if (!cartItem) {
      return ctx.forbidden("You do not have permission to update this cart item", {
        data: {
          success: false,
          error: "You do not have permission to update this cart item",
        },
      });
    }

    const cartService = strapi.service("api::cart.cart");

    // If count is less than 1, remove the cart item instead of updating
    if (!count || count < 1) {
      const result = await cartService.removeCartItem(cartItemId, userId);
      if (!result.success) {
        return ctx.badRequest(result.message, {
          data: { success: false, error: result.message },
        });
      }
      return { data: { message: "Cart item removed successfully" } };
    }

    // Stock only gates an increase. A line can already hold more than is
    // available (stock moved, or a reservation lowered it); rejecting the
    // decrease too would leave the shopper unable to shrink the very quantity
    // that is over the limit, and lowering it can never oversell.
    const currentCount = Number(cartItem.Count) || 0;
    const available = cartItem.product_variation?.product_stock
      ? getAvailableStockCount(cartItem.product_variation.product_stock)
      : 0;
    if (count > currentCount && available < count) {
      return ctx.badRequest("Not enough stock", {
        data: {
          success: false,
          error: "Not enough stock",
          errorCode: "CART_STOCK_EXCEEDED",
          availableStock: available,
        },
      });
    }

    const result = await cartService.updateCartItem(cartItemId, count, userId);
    if (!result.success) {
      return ctx.badRequest(result.message, {
        data: {
          success: false,
          error: result.message,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          ...(typeof result.availableStock === "number"
            ? { availableStock: result.availableStock }
            : {}),
        },
      });
    }
    return { data: result.data };
  } catch (error: any) {
    return ctx.badRequest(error.message, {
      data: { success: false, error: error.message },
    });
  }
};
