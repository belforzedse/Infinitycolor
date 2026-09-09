import React from "react";
import { useCart } from "@/contexts/CartContext";
import XIcon from "@/components/User/Icons/XIcon";

interface CartDrawerHeaderProps {
  onClose?: () => void;
}

export default function CartDrawerHeader({ onClose }: CartDrawerHeaderProps) {
  const { closeDrawer, totalItems } = useCart();

  return (
    <header className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-medium text-neutral-800">سبد خرید</h2>
        <span className="text-sm text-neutral-500">({totalItems} کالا)</span>
      </div>
      <button
        type="button"
        onClick={onClose || closeDrawer}
        className="pressable rounded-full p-2 touch-manipulation transition-colors hover:bg-slate-50"
        aria-label="Close cart"
      >
        <XIcon />
      </button>
    </header>
  );
}
