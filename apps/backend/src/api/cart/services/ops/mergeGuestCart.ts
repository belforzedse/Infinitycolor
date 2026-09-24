import type { Strapi } from "@strapi/strapi";
import { getAvailableStockCount } from "../lib/stock";
import { resolveUserCartId } from "../lib/user-cart-identity";

export type GuestMergeItem = { productVariationId: number; quantity: number };

export function normalizeGuestMergeItems(input: unknown): GuestMergeItem[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    throw new Error("Guest cart items must contain between 1 and 100 entries");
  }
  const totals = new Map<number, number>();
  for (const raw of input) {
    const variationId = Number((raw as any)?.productVariationId);
    const quantity = Number((raw as any)?.quantity);
    if (!Number.isInteger(variationId) || variationId <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("Guest cart item identifiers and quantities must be positive integers");
    }
    totals.set(variationId, Math.min(999, (totals.get(variationId) || 0) + quantity));
  }
  return Array.from(totals, ([productVariationId, quantity]) => ({ productVariationId, quantity }));
}

export async function mergeGuestCart(
  strapi: Strapi,
  userId: number,
  mergeId: string,
  rawItems: unknown,
) {
  const items = normalizeGuestMergeItems(rawItems);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(mergeId)) throw new Error("Invalid guest cart merge id");

  return strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT pg_advisory_xact_lock(?)", [userId]);
    const mergeQuery = strapi.db.query("api::guest-cart-merge.guest-cart-merge");
    const previous: any = await mergeQuery.findOne({
      where: { MergeId: mergeId, user: userId },
      transacting: trx,
    } as any);
    if (previous?.Result) return { ...previous.Result, replayed: true };

    const cartQuery = strapi.db.query("api::cart.cart");
    // Same resolver as every other cart path, inside this transaction: a failed merge
    // rolls back a cart it created, and it can never unlink a cart another request made.
    const cartId = await resolveUserCartId(strapi, userId, trx);
    const cart: any = await cartQuery.findOne({ where: { id: cartId }, transacting: trx } as any);

    const accepted: any[] = [];
    const adjusted: any[] = [];
    const rejected: any[] = [];
    const itemQuery = strapi.db.query("api::cart-item.cart-item");
    const variationQuery = strapi.db.query("api::product-variation.product-variation");

    for (const item of items) {
      const variation: any = await variationQuery.findOne({
        where: { id: item.productVariationId },
        populate: { product: true, product_stock: true },
        transacting: trx,
      } as any);
      const product = variation?.product;
      if (!variation || variation.IsPublished === false || !product || product.removedAt || product.Status !== "Active") {
        rejected.push({ ...item, reason: "UNAVAILABLE" });
        continue;
      }

      const existing: any = await itemQuery.findOne({
        where: { cart: cart.id, product_variation: item.productVariationId },
        transacting: trx,
      } as any);
      const currentQuantity = Number(existing?.Count || 0);
      const available = variation.product_stock ? getAvailableStockCount(variation.product_stock) : 0;
      const appliedQuantity = Math.max(0, Math.min(item.quantity, available - currentQuantity));
      if (appliedQuantity === 0) {
        rejected.push({ ...item, available: Math.max(0, available - currentQuantity), reason: "INSUFFICIENT_STOCK" });
        continue;
      }

      const resultingQuantity = currentQuantity + appliedQuantity;
      const unitPrice = Number(variation.DiscountPrice ?? variation.Price ?? 0);
      if (existing) {
        await itemQuery.update({
          where: { id: existing.id },
          data: { Count: resultingQuantity, Sum: resultingQuantity * unitPrice },
          transacting: trx,
        } as any);
      } else {
        await itemQuery.create({
          data: {
            cart: cart.id,
            product_variation: item.productVariationId,
            Count: resultingQuantity,
            Sum: resultingQuantity * unitPrice,
          },
          transacting: trx,
        } as any);
      }

      const outcome = { ...item, appliedQuantity, resultingQuantity };
      if (appliedQuantity === item.quantity) accepted.push(outcome);
      else adjusted.push({ ...outcome, available: Math.max(0, available - currentQuantity), reason: "QUANTITY_REDUCED" });
    }

    if (accepted.length || adjusted.length || cart.Status !== "Pending") {
      await cartQuery.update({
        where: { id: cart.id },
        data: { Status: accepted.length || adjusted.length ? "Pending" : cart.Status },
        transacting: trx,
      } as any);
    }

    const result = { success: true, mergeId, accepted, adjusted, rejected, replayed: false };
    await mergeQuery.create({
      data: { MergeId: mergeId, Result: result, user: userId },
      transacting: trx,
    } as any);
    return result;
  });
}
