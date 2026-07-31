import { createHash } from "node:crypto";
import type { Strapi } from "@strapi/strapi";
import {
  computeCouponDiscount,
  findFirstActiveGeneralDiscount,
} from "./discounts";
import { computeTotals } from "./financials";

export type CheckoutQuoteInput = {
  cart?: any;
  shippingId?: number | null;
  shippingCost?: number;
  discountCode?: string | null;
  gateway?: string | null;
  reserveGroupId?: string | null;
};

export type CheckoutQuote = {
  quoteHash: string;
  financialSummary: {
    subtotal: number;
    discount: number;
    tax: number;
    shipping: number;
    total: number;
  };
  discountCode?: string;
  appliedGeneralDiscountId?: number;
  lineItems: Array<{
    variationId: number;
    quantity: number;
    unitPrice: number;
  }>;
};

const normalizeGateway = (value: unknown) =>
  String(value || "").trim().toLowerCase();

export async function createCheckoutQuote(
  strapi: Strapi,
  userId: number,
  input: CheckoutQuoteInput,
): Promise<CheckoutQuote> {
  const cart = input.cart ?? (await strapi.service("api::cart.cart").getUserCart(userId));
  const cartItems = Array.isArray(cart?.cart_items) ? cart.cart_items : [];
  if (cartItems.length === 0) {
    throw new Error("CART_EMPTY: Cannot quote an empty cart");
  }

  const lineItems = cartItems
    .map((item: any) => {
      const variation = item?.product_variation;
      const variationId = Number(variation?.id);
      const quantity = Number(item?.Count || 0);
      const unitPrice = Math.round(
        Number(variation?.DiscountPrice ?? variation?.Price ?? 0),
      );
      if (!Number.isInteger(variationId) || variationId <= 0) {
        throw new Error("INVALID_ITEM: Cart item is missing its variation");
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("INVALID_QUANTITY: Cart item quantity is invalid");
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error("INVALID_PRICE: Cart item price is invalid");
      }
      return { variationId, quantity, unitPrice };
    })
    .sort((a: any, b: any) => a.variationId - b.variationId);

  const subtotal = lineItems.reduce(
    (sum: number, item: any) => sum + item.unitPrice * item.quantity,
    0,
  );
  const shipping = Math.max(0, Math.round(Number(input.shippingCost || 0)));
  const discountCode = String(input.discountCode || "").trim() || undefined;
  let discountAmount = 0;
  let appliedGeneralDiscountId: number | undefined;

  if (discountCode) {
    discountAmount = await computeCouponDiscount(
      strapi,
      userId,
      discountCode,
      subtotal,
      cartItems,
      input.shippingId,
    );
  } else {
    const generalDiscounts = await findFirstActiveGeneralDiscount(strapi);
    for (const discount of generalDiscounts) {
      if (Number(discount.MinimumAmount || 0) > subtotal) continue;
      appliedGeneralDiscountId = Number(discount.id);
      if (discount.IsPercentage) {
        discountAmount = (subtotal * Number(discount.Amount || 0)) / 100;
        if (discount.MaxAmount && discountAmount > Number(discount.MaxAmount)) {
          discountAmount = Number(discount.MaxAmount);
        }
      } else {
        discountAmount = Number(discount.Amount || 0);
      }
      break;
    }
  }

  discountAmount = Math.min(subtotal, Math.max(0, Math.round(discountAmount)));
  const financialSummary = computeTotals(subtotal, discountAmount, shipping);
  const canonicalQuote = {
    version: 1,
    userId: Number(userId),
    cartId: Number(cart?.id || 0),
    lineItems,
    shippingId: Number(input.shippingId || 0),
    shipping,
    discountCode: discountCode || null,
    discount: financialSummary.discount,
    gateway: normalizeGateway(input.gateway),
    reserveGroupId: String(input.reserveGroupId || "").trim() || null,
    total: financialSummary.total,
  };
  const quoteHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalQuote))
    .digest("hex")}`;

  return {
    quoteHash,
    financialSummary,
    discountCode,
    appliedGeneralDiscountId,
    lineItems,
  };
}
