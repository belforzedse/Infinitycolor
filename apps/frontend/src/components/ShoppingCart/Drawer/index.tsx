"use client";

import React, { useRef } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { Fragment } from "react";
import { useCart } from "@/contexts/CartContext";
import CartDrawerHeader from "./Header";
import CartDrawerContent from "./Content";
import CartDrawerFooter from "./Footer";
import EmptyCartDrawer from "./Empty";
import { useDrag } from "@use-gesture/react";
import { hapticButton } from "@/utils/haptics";
import { SkeletonBlock, SkeletonText } from "@repo/ui/skeleton";

function CartDrawerSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      {Array.from({ length: 2 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <SkeletonBlock className="h-16 w-16 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2">
            <SkeletonText className="h-4 w-2/3" />
            <SkeletonText tone="light" className="h-4 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CartDrawer() {
  const { isDrawerOpen, closeDrawer, cartItems, isCartReady, isLoading } = useCart();
  const panelRef = useRef<HTMLDivElement>(null);

  // Bind swipe-to-close on the header only. Attaching this to the whole panel
  // with preventDefault captures taps on older WebViews and blocks checkout.
  const bind = useDrag(
    ({ last, movement: [mx], direction: [xDir], velocity: [vx], tap }) => {
      if (tap || !last) return;
      if (typeof window === "undefined" || window.innerWidth >= 1024) return;

      const swipeThreshold = 100;
      const velocityThreshold = 0.5;

      if (mx < -swipeThreshold || (xDir < 0 && Math.abs(vx) > velocityThreshold)) {
        hapticButton();
        closeDrawer();
      }
    },
    {
      axis: "x",
      filterTaps: true,
      pointer: { capture: false },
      preventScroll: false,
    },
  );

  return (
    <Transition appear show={isDrawerOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[1200]" onClose={closeDrawer} dir="rtl">
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/25 backdrop-blur-[2px]" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-hidden">
          <div className="flex h-full items-stretch justify-end text-center text-neutral-800">
            <Transition.Child
              as={Fragment}
              enter="transform transition ease-out duration-300"
              enterFrom="-translate-x-full"
              enterTo="translate-x-0"
              leave="transform transition ease-in-out duration-300"
              leaveFrom="translate-x-0"
              leaveTo="-translate-x-full"
            >
              <Dialog.Panel
                ref={panelRef}
                className="h-dvh h-full min-h-0 w-full max-w-md transform overflow-hidden bg-white shadow-xl transition-all"
                data-testid="cart-drawer"
              >
                <div className="flex h-full min-h-0 flex-col">
                  <div {...bind()} className="shrink-0 touch-pan-y">
                    <CartDrawerHeader onClose={closeDrawer} />
                  </div>

                  {!isCartReady || isLoading ? (
                    <CartDrawerSkeleton />
                  ) : cartItems.length === 0 ? (
                    <EmptyCartDrawer />
                  ) : (
                    <>
                      <CartDrawerContent />
                      <CartDrawerFooter />
                    </>
                  )}
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
