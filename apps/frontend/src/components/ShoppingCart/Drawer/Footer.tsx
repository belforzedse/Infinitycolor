import React from "react";
import Link from "next/link";
import CheckoutLink from "@/components/ShoppingCart/CheckoutLink";
import { useCart } from "@/contexts/CartContext";

export default function CartDrawerFooter() {
  const { totalPrice, closeDrawer } = useCart();

  return (
    <footer className="sticky bottom-0 z-20 shrink-0 border-t border-slate-100 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-neutral-800">مجموع:</span>
        <span className="text-base font-medium text-neutral-800">
          {totalPrice.toLocaleString()} تومان
        </span>
      </div>

      <div className="flex gap-2">
        <Link
          href="/cart"
          prefetch={false}
          data-testid="cart-drawer-view-cart"
          className="pressable flex min-h-11 flex-1 touch-manipulation items-center justify-center rounded-lg bg-slate-100 px-4 py-2 text-center text-sm text-neutral-800"
          onClick={closeDrawer}
        >
          مشاهده سبد خرید
        </Link>

        <CheckoutLink
          testId="cart-drawer-checkout"
          onClick={closeDrawer}
          className="pressable flex min-h-11 flex-1 items-center justify-center rounded-lg bg-infinity-primary px-4 py-2 text-center text-sm text-white"
        >
          تکمیل خرید
        </CheckoutLink>
      </div>
    </footer>
  );
}
