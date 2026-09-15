"use client";

import { useCart } from "@/contexts/CartContext";
import { buildCartStockNoticeText } from "@/utils/cartStock";

/**
 * One calm, non-blocking line saying the cart changed because stock moved.
 *
 * It replaces a modal that interrupted checkout to itemize every change: the
 * shopper had to read a table and re-confirm before paying, which read as an
 * error rather than an update. The corrected quantities are already visible in
 * the cart rows (affected lines are marked in place), so the notice only has to
 * explain *why* they changed — and name the lines that were removed, since
 * those are no longer on screen to speak for themselves.
 */
export default function CartStockNotice() {
  const { stockNotice, dismissStockNotice } = useCart();

  if (!stockNotice) return null;

  return (
    <div
      id="cart-stock-notice"
      role="status"
      aria-live="polite"
      data-testid="cart-stock-notice"
      className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-right text-sm text-amber-900"
    >
      <p className="flex-1">{buildCartStockNoticeText(stockNotice)}</p>
      <button
        type="button"
        onClick={dismissStockNotice}
        aria-label="بستن اعلان"
        data-testid="cart-stock-notice-dismiss"
        className="shrink-0 rounded-lg px-2 py-0.5 text-amber-700 transition-colors hover:bg-amber-100"
      >
        ✕
      </button>
    </div>
  );
}
