"use client";

import { useState, useEffect } from "react";
import CartIcon from "../../Icons/CartIcon";
import MenuIcon from "../../Icons/MenuIcon";
import { StorefrontLogo } from "@repo/brand";
import { useCart } from "@/contexts/CartContext";
import { useMobileMenu } from "@/contexts/MobileMenuContext";
import { usePathname } from "next/navigation";
import MobileBackButton from "@/components/MobileBackButton";
import { getMobileBackFallbackHref } from "@/utils/mobileBackNavigation";
import { useCartShellReady } from "@/hooks/useCartShellReady";

type Props = object;

export default function PLPMobileHeader({}: Props) {
  const { openMenu } = useMobileMenu();
  const { totalItems, openDrawer } = useCart();
  const isCartShellReady = useCartShellReady();
  const visibleTotalItems = isCartShellReady ? totalItems : 0;
  const [isStandalone, setIsStandalone] = useState(false);
  const pathname = usePathname();
  const backFallbackHref = getMobileBackFallbackHref(pathname);

  useEffect(() => {
    if (typeof window !== "undefined" && "matchMedia" in window) {
      const mq = window.matchMedia("(display-mode: standalone)");
      setIsStandalone(mq.matches);

      const handleChange = (e: MediaQueryListEvent) => {
        setIsStandalone(e.matches);
      };

      if (mq.addEventListener) {
        mq.addEventListener("change", handleChange);
        return () => mq.removeEventListener("change", handleChange);
      } else if (mq.addListener) {
        mq.addListener(handleChange);
        return () => mq.removeListener(handleChange);
      }
    }
  }, []);

  return (
    <>
      {/* Safe area white bar for standalone mode */}
      {isStandalone && (
        <div
          className="fixed left-0 right-0 top-0 z-[60] bg-white lg:hidden"
          style={{ height: "env(safe-area-inset-top)" }}
        />
      )}
      <div
        className="lg:hidden"
        style={{
          marginTop: isStandalone ? "env(safe-area-inset-top)" : "0",
        }}
      >
        {/* Mobile header row — dir=ltr so left/right are screen-physical */}
        <div
          className="relative flex min-h-[4.25rem] items-center px-5 py-2 sm:px-6 lg:hidden"
          dir="ltr"
        >
          {/* Absolutely-centered logo */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto" dir="rtl">
              <StorefrontLogo width={72} height={45} />
            </div>
          </div>

          {/* Physical LEFT: cart button */}
          <div className="relative z-10 flex items-center justify-start">
            <button
              onClick={openDrawer}
              className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-infinity-primary text-infinity-primary-foreground transition-colors hover:bg-infinity-primary-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-infinity-primary"
              aria-label="سبد خریدتان"
            >
              <CartIcon className="text-white" />
              {visibleTotalItems > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-infinity-primary-dark text-[10px] font-medium leading-none text-white">
                  {visibleTotalItems > 9 ? "9+" : visibleTotalItems}
                </span>
              )}
            </button>
          </div>

          {/* Physical RIGHT: menu + optional back button */}
          <div className="relative z-10 ml-auto flex items-center gap-2">
            <button
              onClick={() => openMenu()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-infinity-primary"
              aria-label="فهرست"
            >
              <MenuIcon className="text-neutral-700" />
            </button>

            {backFallbackHref && (
              <MobileBackButton fallbackHref={backFallbackHref} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
