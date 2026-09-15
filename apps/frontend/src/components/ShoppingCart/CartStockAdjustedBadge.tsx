"use client";

import { useCart } from "@/contexts/CartContext";

/**
 * Marks a cart line whose quantity the server reduced, so the banner above the
 * cart does not have to itemize the changes: the shopper reads "stock changed"
 * once, then sees exactly which rows it meant.
 */
export default function CartStockAdjustedBadge({ cartItemId }: { cartItemId?: string }) {
  const { stockNotice } = useCart();

  if (!cartItemId || !stockNotice?.adjustedCartItemIds.includes(cartItemId)) return null;

  return (
    <span
      data-testid="cart-stock-adjusted-badge"
      className="mt-1 inline-flex w-fit rounded-md bg-amber-50 px-2 py-0.5 text-xs text-amber-800"
    >
      تعداد بر اساس موجودی به‌روز شد
    </span>
  );
}
