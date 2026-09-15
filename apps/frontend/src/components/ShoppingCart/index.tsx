"use client";

import React from "react";
import EmptyShoppingCart from "./Empty";
import ShoppingCartSuccessOrderSubmit from "./SuccessOrderSubmit";
import { submitOrderStepAtom } from "@/atoms/Order";
import { useAtom } from "jotai";
import { SubmitOrderStep } from "@/types/Order";
import ShoppingCartBillForm from "./Bill";
import ShoppingCartMobileTable from "./Table/Mobile";
import ShoppingCartDesktopTable from "./Table/Desktop";
import { useCart } from "@/contexts/CartContext";
import CartSkeleton from "@/components/Skeletons/CartSkeleton";
import CartStockNotice from "./CartStockNotice";
import { useCartShellReady } from "@/hooks/useCartShellReady";

function ShoppingCart() {
  const [submitOrderStep, setSubmitOrderStep] = useAtom(submitOrderStepAtom);
  const { cartItems, isLoading } = useCart();
  const isCartShellReady = useCartShellReady();

  if (!isCartShellReady || isLoading) return <CartSkeleton />;

  // A stock correction can empty the cart outright. Keep the notice above the
  // empty state, or the shopper's items vanish with no explanation at all.
  if (cartItems.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <CartStockNotice />
        <EmptyShoppingCart />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-20">
      <span className="w-full text-3xl text-neutral-800">سبد خرید</span>

      {/* Above both steps, so the same notice covers the cart list and the bill. */}
      <CartStockNotice />

      {submitOrderStep === SubmitOrderStep.Table && (
        <div key="table">
          <ShoppingCartDesktopTable cartItems={cartItems} className="hidden lg:block" />

          <ShoppingCartMobileTable cartItems={cartItems} className="lg:hidden" />

          <button
            onClick={() => setSubmitOrderStep(SubmitOrderStep.Bill)}
            className="w-fit rounded-lg bg-infinity-primary px-6 py-2 text-sm text-white"
          >
            ادامه فرآیند خرید و تسویه حساب
          </button>
        </div>
      )}

      {submitOrderStep === SubmitOrderStep.Bill && (
        <div key="bill">
          <ShoppingCartBillForm />
        </div>
      )}

      {submitOrderStep === SubmitOrderStep.Success && (
        <div key="success">
          <ShoppingCartSuccessOrderSubmit />
        </div>
      )}
    </div>
  );
}

export default ShoppingCart;
