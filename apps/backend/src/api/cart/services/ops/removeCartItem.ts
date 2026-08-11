import type { Strapi } from "@strapi/strapi";

/**
 * Removes one cart line owned by `ownerUserId`.
 *
 * `ownerUserId` is required, not optional. A cart-item id supplied by a client only
 * identifies a candidate row; ownership is what authorizes the mutation, so the lookup
 * is scoped by `cart.user` rather than checked afterwards by a caller that may forget.
 * Privileged code that legitimately needs to act on someone else's cart should use an
 * explicitly named internal operation instead of omitting this argument.
 */
export const removeCartItemOp = async (
  strapi: Strapi,
  cartItemId: number,
  ownerUserId: number
) => {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) {
    return { success: false, message: "Cart owner is required" };
  }

  const cartItem = await strapi.db.query("api::cart-item.cart-item").findOne({
    where: { id: cartItemId, cart: { user: { id: ownerUserId } } },
    populate: { cart: true },
  });
  if (!cartItem) {
    return { success: false, message: "Cart item not found" };
  }

  const cartId = cartItem.cart.id;
  await strapi.entityService.delete("api::cart-item.cart-item", cartItemId);

  const remainingItems = await strapi.db
    .query("api::cart-item.cart-item")
    .count({ where: { cart: cartId } });
  if (remainingItems === 0) {
    await strapi.entityService.update("api::cart.cart", cartId, {
      data: { Status: "Empty" },
    });
  }
  return { success: true };
};
