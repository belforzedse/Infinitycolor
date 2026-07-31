/**
 * How much the customer has actually paid on an order, in Toman.
 *
 * Shared by the admin cancel and admin adjust-items handlers, which both use it
 * to size a refund. It previously existed as two identical copies.
 *
 * IMPORTANT — `Amount` is already net of discount. `computeTotals`
 * (api/cart/services/lib/financials.ts) defines
 *   total = subtotal - discountAmount + shipping
 * and every transaction writer persists `Amount = total * 10`:
 *   - gateway-helpers.ts (SamanKish, ZarinPal)
 *   - wallet-settlement.ts (Wallet)
 *   - cart.ts (SnappPay)
 *   - payment.ts (Mellat, SamanKish)
 * `DiscountAmount` is stored alongside it purely for reporting. Subtracting it
 * here as well double-counted the discount, which under-refunded the customer by
 * the discount amount and left a residual positive balance that kept fully
 * refunded orders inside the reports' `paid_orders` definition forever.
 */
export const computePaidAmountToman = (order: any): number => {
  if (String(order?.Status) === "Paying") return 0;
  const txList = order?.contract?.contract_transactions || [];
  let paidIrr = 0;

  if (Array.isArray(txList) && txList.length > 0) {
    for (const tx of txList) {
      const amountIrr = Number(tx?.Amount || 0);
      if (!amountIrr) continue;
      const type = String(tx?.Type || "").toLowerCase();
      const status = String(tx?.Status || "").toLowerCase();

      if (type === "gateway" && status !== "failed") {
        paidIrr += amountIrr;
      } else if (type === "return") {
        paidIrr -= amountIrr;
      }
    }
  } else {
    const fallback = Number(order?.contract?.Amount || 0);
    if (fallback > 0) {
      return fallback;
    }
  }

  const paidToman = Math.round(paidIrr / 10);
  if (paidToman > 0) return paidToman;

  const fallback = Number(order?.contract?.Amount || 0);
  return Math.max(0, fallback);
};
