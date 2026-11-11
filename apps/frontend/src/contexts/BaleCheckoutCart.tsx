"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { CartItem } from "./CartContext";
import type { CartResponse } from "@/services/cart/types/cart";
import { CartService } from "@/services";

function checkoutItems(cart: CartResponse): CartItem[] {
  return cart.cart_items.flatMap((line) => {
    const variation = line.product_variation;
    const product = variation?.product;
    if (!product) return [];
    return [{
      id: String(variation.id),
      slug: String(product.id),
      productId: String(product.id),
      variationId: String(variation.id),
      name: product.Title,
      category: product.product_main_category?.Title ?? "",
      price: Number(line.Sum) / line.Count,
      originalPrice: Number(variation.Price),
      quantity: line.Count,
      image: "",
      size: variation.product_variation_size?.Title,
      color: variation.product_variation_color?.Title,
      model: variation.product_variation_model?.Title,
      availableStock: line.availableStock,
    }];
  });
}

/** The recipient and address the shopper already gave the Bale bot. */
export type BaleRecipient = {
  fullName: string;
  phone: string;
  provinceId: number;
  provinceTitle: string;
  cityId: number;
  cityTitle: string;
  postalCode: string;
  address: string;
};

type BaleCart = {
  checkoutId: string;
  recipient?: BaleRecipient;
  shippingMethodId?: number | null;
  cartItems: CartItem[];
  totalItems: number;
  totalPrice: number;
  subtotalBeforeDiscount: number;
  cartDiscountTotal: number;
  refreshCart: (options?: { silent?: boolean }) => Promise<void>;
};

const BaleCartContext = createContext<BaleCart | null>(null);

export function useBaleCheckoutCart() {
  return useContext(BaleCartContext);
}

export function BaleCheckoutCartProvider({
  checkoutId, initialCart, recipient, shippingMethodId, children,
}: {
  checkoutId: string;
  initialCart: CartResponse;
  recipient?: BaleRecipient;
  shippingMethodId?: number | null;
  children: ReactNode;
}) {
  const [cart, setCart] = useState(initialCart);
  const value = useMemo(() => {
    const cartItems = checkoutItems(cart);
    const totalPrice = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const subtotalBeforeDiscount = cartItems.reduce(
      (sum, item) => sum + (item.originalPrice ?? item.price) * item.quantity,
      0,
    );
    return {
      checkoutId,
      recipient,
      shippingMethodId,
      cartItems,
      totalItems: cartItems.reduce((sum, item) => sum + item.quantity, 0),
      totalPrice,
      subtotalBeforeDiscount,
      cartDiscountTotal: Math.max(0, subtotalBeforeDiscount - totalPrice),
      refreshCart: async () => setCart(await CartService.getUserCart(checkoutId)),
    };
  }, [cart, checkoutId, recipient, shippingMethodId]);
  return <BaleCartContext.Provider value={value}>{children}</BaleCartContext.Provider>;
}
