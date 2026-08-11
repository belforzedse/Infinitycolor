import type { Strapi } from "@strapi/strapi";
import { runRawSql } from "../../../../utils/transactionExecutor";

/**
 * Post-payment cart cleanup, scoped to what the checkout actually consumed.
 *
 * The old behavior called `clearCart(userId)` from every settlement path, which deletes
 * whatever happens to be in the customer's cart when the callback lands. A customer who
 * adds items while sitting on the gateway page loses them; a customer who deletes and
 * re-adds the same SKU loses the new line too, because SKU identity cannot distinguish
 * "the line this order consumed" from "a line created afterwards".
 *
 * Cleanup therefore consumes `order_items.SourceCartItemId` — the exact cart line the
 * order line was built from — and decrements it by the historical purchased quantity
 * rather than deleting whatever is there now.
 *
 * Idempotency is durable, not inferred from quantities: `orders.CartCleanupCompletedAt`
 * is claimed with a guarded UPDATE in the same transaction as the cart mutations, so a
 * retry is either a complete no-op or a complete apply. A NULL marker on a paid order is
 * the signal the reconciliation sweep looks for.
 */

export type CartCleanupOutcome = {
  status: "applied" | "already_applied" | "nothing_to_consume";
  consumedLines?: number;
  deletedLines?: number;
};

const CART_ITEM_UID = "api::cart-item.cart-item";

const resolveUserId = (order: any): number | null => {
  const relation = order?.user;
  const id = typeof relation === "object" && relation ? relation.id : relation;
  const numeric = Number(id);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

/**
 * Consumes the cart lines this order was built from, exactly once.
 *
 * Throws on failure so callers can record it; the marker stays NULL, which is what makes
 * the work retryable. Payment success must not depend on this succeeding.
 */
export async function consumeCheckoutCartLines(
  strapi: Strapi,
  orderId: number,
): Promise<CartCleanupOutcome> {
  return strapi.db.transaction(async ({ trx }) => {
    // Claim first, in the same transaction as the mutations below. If anything after
    // this throws, the claim rolls back with it and the order stays sweepable.
    const claim = await runRawSql(
      strapi,
      `UPDATE orders
       SET cart_cleanup_completed_at = ?
       WHERE id = ?
         AND cart_cleanup_completed_at IS NULL
       RETURNING id`,
      [new Date(), orderId],
      trx,
    );
    if ((claim?.rows || []).length === 0) {
      return { status: "already_applied" as const };
    }

    const order: any = await strapi.db.query("api::order.order").findOne({
      where: { id: orderId },
      populate: { user: true, order_items: true },
      transacting: trx,
    } as any);
    if (!order) throw new Error("CART_CLEANUP_ORDER_NOT_FOUND");

    const userId = resolveUserId(order);
    if (!userId) throw new Error("CART_CLEANUP_ORDER_HAS_NO_USER");

    const sourceLines = (order.order_items || [])
      .map((item: any) => ({
        cartItemId: Number(item?.SourceCartItemId),
        quantity: Number(item?.Count || 0),
      }))
      .filter(
        (line: any) =>
          Number.isInteger(line.cartItemId) &&
          line.cartItemId > 0 &&
          Number.isFinite(line.quantity) &&
          line.quantity > 0,
      );

    if (sourceLines.length === 0) {
      // Pre-migration order, or a manual order with no cart behind it. Nothing to
      // consume; the marker stays set so the sweep does not keep revisiting it.
      return { status: "nothing_to_consume" as const };
    }

    // Several order lines can point at one cart line only if the cart itself was
    // malformed, but aggregate defensively so the decrement is still exact.
    const quantityByCartItem = new Map<number, number>();
    for (const line of sourceLines) {
      quantityByCartItem.set(
        line.cartItemId,
        (quantityByCartItem.get(line.cartItemId) || 0) + line.quantity,
      );
    }

    const itemQuery = strapi.db.query(CART_ITEM_UID);
    let consumedLines = 0;
    let deletedLines = 0;
    let cartId: number | null = null;

    for (const [cartItemId, quantity] of Array.from(quantityByCartItem.entries()).sort(
      (a, b) => a[0] - b[0],
    )) {
      // Scoped to this order's owner: a stale source id must never reach into another
      // customer's cart, however it got onto the order.
      const cartItem: any = await itemQuery.findOne({
        where: { id: cartItemId, cart: { user: { id: userId } } },
        populate: { cart: true, product_variation: true },
        transacting: trx,
      } as any);

      // The source line is gone (customer deleted it, or a previous partial run). A
      // re-added line for the same SKU has a different id and is deliberately not
      // touched here.
      if (!cartItem) continue;

      cartId = Number(cartItem.cart?.id) || cartId;
      const currentCount = Number(cartItem.Count || 0);
      const remaining = currentCount - quantity;

      if (remaining > 0) {
        const unitPrice = Number(
          cartItem.product_variation?.DiscountPrice ?? cartItem.product_variation?.Price ?? 0,
        );
        await itemQuery.update({
          where: { id: cartItemId },
          data: { Count: remaining, Sum: remaining * unitPrice },
          transacting: trx,
        } as any);
      } else {
        await itemQuery.delete({ where: { id: cartItemId }, transacting: trx } as any);
        deletedLines += 1;
      }
      consumedLines += 1;
    }

    if (cartId) {
      const remainingItems = await itemQuery.count({
        where: { cart: cartId },
        transacting: trx,
      } as any);
      if (Number(remainingItems) === 0) {
        await strapi.db.query("api::cart.cart").update({
          where: { id: cartId },
          data: { Status: "Empty" },
          transacting: trx,
        } as any);
      }
    }

    return { status: "applied" as const, consumedLines, deletedLines };
  });
}

/**
 * Settlement-side wrapper: never lets a cleanup failure turn a successful payment into a
 * failed one, but records the failure durably so the sweep retries it and an operator
 * can see it. Returns whether cleanup is now complete.
 */
export async function consumeCheckoutCartLinesSafely(
  strapi: Strapi,
  orderId: number,
  context: { gateway?: string } = {},
): Promise<boolean> {
  if (!Number.isInteger(Number(orderId)) || Number(orderId) <= 0) {
    strapi.log.warn("Cart cleanup skipped: invalid order id", { orderId });
    return false;
  }

  try {
    const outcome = await consumeCheckoutCartLines(strapi, Number(orderId));
    strapi.log.info("Checkout cart lines consumed", { orderId, ...outcome, ...context });
    return true;
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 300);
    strapi.log.error("Failed to consume checkout cart lines; left pending for retry", {
      orderId,
      gateway: context.gateway,
      error: message,
    });
    // Durable, operator-visible record. The retryable state itself is
    // orders.CartCleanupCompletedAt staying NULL, which the reconcile sweep scans.
    try {
      await strapi.db.query("api::order-log.order-log").create({
        data: {
          order: orderId,
          Action: "Update",
          Description: "Cart cleanup failed after successful payment; pending retry",
          Changes: { gateway: context.gateway || null, error: message },
        },
      } as any);
    } catch (logError: any) {
      strapi.log.error("Failed to record cart cleanup failure", {
        orderId,
        error: String(logError?.message || logError).slice(0, 300),
      });
    }
    return false;
  }
}
