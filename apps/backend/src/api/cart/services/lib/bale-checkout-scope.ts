import type { BaleCheckout } from "../../../bale-checkout/services/handoff";
import { chargeableVariationPrice } from "../../../../utils/productAvailability";
import { isProductPubliclyVisible } from "../../../../utils/productVisibility";
import { getAvailableStockCount } from "./stock";
import type { CheckCartStockResult } from "../ops/checkCartStock";

export type BaleCheckoutScope = {
  checkout: BaleCheckout;
  cart: Awaited<ReturnType<typeof import("../../../bale-checkout/services/handoff").loadBaleCheckoutCart>>;
};

export function checkBaleCheckoutStock({ cart }: BaleCheckoutScope): CheckCartStockResult {
  const stockById = new Map<number, number>();
  const itemsRemoved = [];
  for (const item of cart.cart_items) {
    const variation = item.product_variation;
    const stock = variation?.product_stock;
    const available = stock
      ? (stockById.get(stock.id) ?? getAvailableStockCount(stock))
      : 0;
    if (
      !isProductPubliclyVisible(variation?.product) ||
      variation?.IsPublished !== true ||
      chargeableVariationPrice(variation) <= 0 ||
      available < item.Count
    ) {
      itemsRemoved.push({
        productVariationId: variation?.id ?? item.variationId,
        productTitle: variation?.product?.Title,
        requested: item.Count,
        available,
      });
      continue;
    }
    stockById.set(stock.id, available - item.Count);
  }
  // The bot's selection is immutable. The customer can request a revised
  // selection in Bale if any line is no longer purchasable.
  return {
    success: true,
    valid: itemsRemoved.length === 0 && cart.cart_items.length > 0,
    cart,
    itemsRemoved,
    itemsAdjusted: [],
    cartIsEmpty: cart.cart_items.length === 0,
  };
}

export function baleCheckoutPaymentExists(orderId: number) {
  return {
    success: false as const,
    status: 409,
    errorCode: "BALE_CHECKOUT_PAYMENT_EXISTS",
    message: "وضعیت پرداخت این سفارش را بررسی کنید.",
    orderId,
  };
}

export function attemptMatchesCheckout(
  attempt: { order?: unknown },
  bale?: BaleCheckoutScope,
): boolean {
  const order = attempt.order as { BaleCheckoutId?: string } | null;
  return (order?.BaleCheckoutId || null) === (bale?.checkout.checkoutId || null);
}
