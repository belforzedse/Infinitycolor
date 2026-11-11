import type { Strapi } from "@strapi/strapi";
import { createCheckoutQuote } from "../../cart/services/lib/checkout-quote";
import { computeTotals } from "../../cart/services/lib/financials";
import { loadBaleCheckoutCart } from "../services/handoff";
import { readBaleCity } from "./catalog";
import { validateBaleItemAvailability } from "./inventory";
import { BaleApiError, type BaleItem } from "./protocol";

/**
 * What the shopper will pay before signing in on the site: items, the site-wide
 * discount, and every shipping method that serves the city, each with its total.
 *
 * It runs the same price, discount and shipping-rule code as the site checkout,
 * but with no account. Coupons and role-specific shipping rules (e.g. staff)
 * only apply on the site, which recomputes the amount before payment.
 */
export async function quoteBaleItems(
  strapi: Strapi, items: BaleItem[], cityId: number, shippingMethodId: number | null,
) {
  await validateBaleItemAvailability(strapi, items);
  const city = await readBaleCity(strapi, cityId);
  const cart = await loadBaleCheckoutCart(strapi, { items });
  const { financialSummary, lineItems } = await createCheckoutQuote(strapi, 0, { cart, shippingCost: 0 });
  const { subtotal, discount } = financialSummary;
  const methods: any[] = await strapi.service("api::shipping.shipping").getAvailableMethodsForCart(
    0, { addressPayload: { shipping_city: cityId } }, { cart },
  );
  const shippingOptions = methods.map((method) => ({
    id: Number(method.id),
    code: String(method.code),
    title: String(method.title ?? ""),
    description: String(method.description ?? ""),
    estimatedDeliveryText: String(method.estimatedDeliveryText ?? ""),
    priceToman: Number(method.price),
    totalToman: computeTotals(subtotal, discount, Number(method.price)).total,
  }));
  const shippingMethod = shippingMethodId === null
    ? null
    : shippingOptions.find((option) => option.id === shippingMethodId) ?? null;
  if (shippingMethodId !== null && !shippingMethod) {
    throw new BaleApiError(409, "BALE_SHIPPING_UNAVAILABLE", "This shipping method does not serve this address and cart.", {
      shippingOptions,
    });
  }
  return {
    city,
    items: lineItems.map(({ variationId, quantity, unitPrice }) => ({
      variationId, quantity, unitPriceToman: unitPrice, lineTotalToman: unitPrice * quantity,
    })),
    subtotalToman: subtotal,
    discountToman: discount,
    shippingOptions,
    ...(shippingMethod
      ? { shippingMethod, shippingToman: shippingMethod.priceToman, totalToman: shippingMethod.totalToman }
      : {}),
  };
}
