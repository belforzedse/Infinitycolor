"use client";

import React, { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import { categoryOverlayOpenAtom } from "@/atoms/storefrontOverlay";
import Link from "next/link";
import { usePathname } from "next/navigation";
import CategoryCard from "@/components/Categories/CategoryCard";
import CategoryIcon from "./Icons/CategoryIcon";
import SearchIcon from "./Icons/SearchIcon";
import BasketIcon from "./Icons/BasketIcon";
import ProfileIcon from "./Icons/ProfileIcon";
import AccountAccessMenu from "@/components/PLP/Header/AccountAccessMenu";
import { useCart } from "@/contexts/CartContext";
import { useMobileMenu } from "@/contexts/MobileMenuContext";
import { hapticButton } from "@/utils/haptics";
import { STOREFRONT_MAIN_CATEGORY_OPTIONS } from "@/constants/categories";
import { useProductCategories } from "@/hooks/useProductCategories";
import { useCartShellReady } from "@/hooks/useCartShellReady";
import { useCurrentUser } from "@/hooks/useCurrentUser";

const INFINITY_MARK_SRC = "/Infinity.svg";

function cx(...parts: (string | undefined | false)[]): string {
  return parts.filter(Boolean).join(" ");
}

function TabIndicator({ active }: { active: boolean }) {
  return (
    <span
      className={cx(
        "h-[3px] w-[17px] shrink-0 rounded-full",
        active ? "bg-infinity-primary" : "bg-black/[0.08]",
      )}
      aria-hidden
    />
  );
}

type NavTabLinkProps = {
  href: string;
  prefetch?: boolean;
  active: boolean;
  ariaLabel: string;
  inactiveIconClassName: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  children: React.ReactNode;
};

function NavTabLink({
  href,
  prefetch,
  active,
  ariaLabel,
  inactiveIconClassName,
  onClick,
  children,
}: NavTabLinkProps) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      onClick={onClick}
      className={cx(
        "flex h-8 w-6 flex-col items-center justify-end gap-2 justify-self-center",
        active ? "text-infinity-primary" : inactiveIconClassName,
      )}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
    >
      {children}
      <TabIndicator active={active} />
    </Link>
  );
}

const PLPBottomNavigation = () => {
  const pathname = usePathname();
  const { openMenu } = useMobileMenu();
  const { totalItems } = useCart();
  const isCartShellReady = useCartShellReady();
  const visibleTotalItems = isCartShellReady ? totalItems : 0;
  const { isAuthenticated } = useCurrentUser();
  const { categories, isLoading: isLoadingCategories } = useProductCategories({
    ...STOREFRONT_MAIN_CATEGORY_OPTIONS,
  });
  const [isCategoriesMounted, setIsCategoriesMounted] = useState(false);
  const [isCategoriesVisible, setIsCategoriesVisible] = useState(false);

  const handleCategoriesClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    hapticButton();
    setIsCategoriesMounted(true);
    requestAnimationFrame(() => setIsCategoriesVisible(true));
  };

  const handleSearchClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    hapticButton();
    openMenu({ focusSearch: true });
  };

  const setCategoryOverlayOpen = useSetAtom(categoryOverlayOpenAtom);
  useEffect(() => {
    setCategoryOverlayOpen(isCategoriesMounted);
    return () => setCategoryOverlayOpen(false);
  }, [isCategoriesMounted, setCategoryOverlayOpen]);

  const closeCategories = () => {
    setIsCategoriesVisible(false);
    window.setTimeout(() => setIsCategoriesMounted(false), 250);
  };

  useEffect(() => {
    if (!isCategoriesMounted) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCategories();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = original;
      window.removeEventListener("keydown", onKey);
    };
  }, [isCategoriesMounted]);

  const isCartActive = pathname === "/cart";
  const isProfileActive = isAuthenticated
    ? pathname === "/account" || pathname.startsWith("/account/")
    : pathname.startsWith("/auth");

  return (
    <>
      {/*
        Stay above the issue-report trigger (z-80) so the admin account widget
        can stack over it on mobile, and below the category overlay (z-110).
      */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[90] lg:hidden">
        <div className="mx-auto mb-3 max-w-[560px] px-3 pb-[env(safe-area-inset-bottom)] sm:px-5">
          <nav
            data-bottom-nav
            data-adaptive-surface
            aria-label="ناوبری اصلی"
            className="pointer-events-auto flex w-full flex-col items-start gap-[10px] rounded-[20px] bg-white px-2 pb-[5px] pt-[10px] shadow-[0_4px_19px_rgba(57,57,57,0.05)] sm:px-6"
            dir="ltr"
          >
            <div className="grid h-16 w-full grid-cols-[repeat(2,minmax(0,1fr))_4rem_repeat(2,minmax(0,1fr))] items-center">
              <div className="flex justify-self-center">
                <AccountAccessMenu
                  triggerAriaLabel="Account"
                  triggerClassName={cx(
                    "flex h-8 w-6 flex-col items-center justify-end gap-2",
                    isProfileActive ? "text-infinity-primary" : "text-[#A49BA0]",
                  )}
                  triggerContent={
                    <>
                      <ProfileIcon className="size-6 shrink-0 stroke-current" />
                      <TabIndicator active={isProfileActive} />
                    </>
                  }
                  ariaCurrent={isProfileActive ? "page" : undefined}
                  menuPosition="top"
                  menuAlign="center"
                  onNavigate={hapticButton}
                  onTriggerClick={hapticButton}
                />
              </div>

              <NavTabLink
                href="/cart"
                prefetch={false}
                active={isCartActive}
                inactiveIconClassName="text-[#A3A3A3]"
                ariaLabel="سبد خرید"
              >
                <div className="relative">
                  <BasketIcon className="size-6 shrink-0 stroke-current" />
                  {visibleTotalItems > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-infinity-primary text-[10px] font-medium text-white">
                      {visibleTotalItems > 9 ? "9+" : visibleTotalItems}
                    </span>
                  )}
                </div>
              </NavTabLink>

              {/* Adapted from the Social app's infinity circle: same solid
                  infinity-primary fill and mark, rather than the gradient that
                  app uses for its create-post button. Points at the storefront
                  home instead of infinitygram. */}
              <Link
                href="/"
                aria-label="خانه اینفینیتی"
                className="flex size-16 shrink-0 items-center justify-center justify-self-center rounded-full bg-infinity-primary shadow-[0_0_5.8px_rgba(0,0,0,0.09)]"
              >
                <img
                  src={INFINITY_MARK_SRC}
                  alt=""
                  width={49}
                  height={49}
                  className="size-[49px] object-contain"
                />
              </Link>

              <NavTabLink
                href="#"
                prefetch={false}
                active={false}
                inactiveIconClassName="text-[#A3A3A3]"
                ariaLabel="دسته بندی ها"
                onClick={handleCategoriesClick}
              >
                <CategoryIcon className="size-6 shrink-0 stroke-current" />
              </NavTabLink>

              <NavTabLink
                href="#"
                prefetch={false}
                active={false}
                inactiveIconClassName="text-[#A3A3A3]"
                ariaLabel="جستجو"
                onClick={handleSearchClick}
              >
                <SearchIcon className="size-6 shrink-0 stroke-current" />
              </NavTabLink>
            </div>
          </nav>
        </div>
      </div>

      {isCategoriesMounted && (
        <div
          className={`fixed inset-0 z-[110] flex items-end justify-center transition-opacity duration-200 lg:hidden ${
            isCategoriesVisible ? "bg-black/40 opacity-100" : "bg-black/0 opacity-0"
          }`}
          onClick={closeCategories}
        >
          <div
            className={`luxury-glass-panel duration-250 max-h-[80vh] w-full max-w-screen-sm translate-y-0 rounded-t-2xl bg-white/80 p-4 shadow-2xl transition-transform ease-out ${
              isCategoriesVisible ? "translate-y-0" : "translate-y-full"
            }`}
            data-adaptive-surface
            style={{ transitionDuration: "250ms" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold">دسته بندی ها</h3>
              <button
                aria-label="Close categories"
                onClick={closeCategories}
                className="pressable luxury-glass-chip rounded-full p-2 text-neutral-500 hover:text-neutral-800"
              >
                ×
              </button>
            </div>

            <div className="grid grid-cols-3 gap-4 overflow-y-auto pb-2">
              {isLoadingCategories &&
                Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="flex flex-col items-center gap-2">
                    <div className="skeleton-shimmer h-20 w-20 rounded-full" />
                    <div className="skeleton-shimmer-light h-3 w-16 rounded" />
                  </div>
                ))}
              {!isLoadingCategories && categories.length === 0 && (
                <div className="col-span-3 text-center text-xs text-neutral-500">
                  دسته‌بندی برای نمایش وجود ندارد.
                </div>
              )}
              {!isLoadingCategories &&
                categories.map((category) => (
                  <CategoryCard
                    key={category.id}
                    category={category}
                    size="compact"
                    onClick={closeCategories}
                    className="pressable"
                  />
                ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default PLPBottomNavigation;
