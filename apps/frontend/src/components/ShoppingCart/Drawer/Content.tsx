import React from "react";
import { useCart } from "@/contexts/CartContext";
import CartDrawerItem from "./Item";

export default function CartDrawerContent() {
  const { cartItems } = useCart();

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5"
      data-testid="cart-drawer-scroll-region"
    >
      <div className="flex flex-col gap-4">
        {cartItems.map((item) => (
          <CartDrawerItem key={`${item.id}-${item.cartItemId ?? item.slug}`} item={item} />
        ))}
      </div>
    </div>
  );
}
