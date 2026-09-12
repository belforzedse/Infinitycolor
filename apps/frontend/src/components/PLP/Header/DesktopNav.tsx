"use client";

import ChevronDownIcon from "@/components/Search/Icons/ChevronDownIcon";
import Link from "next/link";
import { useProductCategories } from "@/hooks/useProductCategories";
import { usePathname, useSearchParams } from "next/navigation";
import { getCategoryPlpHref, isActiveNavHref } from "@/utils/plpRoutes";
import { StorefrontContainer } from "@/components/storefront/StorefrontContainer";
import { OPPSI_HEADER_ITEM } from "@/constants/categories";
import DesktopMegaMenu from "./DesktopMegaMenu";
import SaleBadgeIcon from "./SaleBadgeIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import type { ProductCategorySummary } from "@/services/product/categories";
import { withHeaderExtraCategories } from "@/utils/headerExtraCategories";

interface NavItem {
  key: string;
  label: string;
  href: string;
  category?: ProductCategorySummary;
  icon?: "sale";
}

export default function PLPHeaderDesktopNav() {
  const { categories: navbarCategories, isLoading: loading } = useProductCategories({
    navbarAssignedOnly: true,
    includeChildren: true,
  });
  const categories = useMemo(
    () => withHeaderExtraCategories(navbarCategories),
    [navbarCategories],
  );
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null);
  const [renderedCategory, setRenderedCategory] = useState<ProductCategorySummary | null>(null);

  const navItems: NavItem[] = useMemo(
    () => [
      { key: "home", label: "خانه", href: "/" },
      ...categories.map((item) => ({
        key: `category-${item.id}`,
        label: item.name,
        href: getCategoryPlpHref(item.slug),
        category: item,
      })),
      {
        key: OPPSI_HEADER_ITEM.key,
        label: OPPSI_HEADER_ITEM.label,
        href: OPPSI_HEADER_ITEM.href,
      },
      {
        key: "discounts",
        label: "تخفیف‌ها",
        href: "/plp?hasDiscount=true",
        icon: "sale",
      },
      { key: "blog", label: "مقالات", href: "/blog" },
    ],
    [categories],
  );

  const activeCategory = categories.find((category) => category.id === activeCategoryId) ?? null;
  const megaMenuCategory = activeCategory ?? renderedCategory;

  const closeMegaMenu = () => setActiveCategoryId(null);

  useEffect(() => {
    if (!activeCategoryId) return;
    if (!categories.some((category) => category.id === activeCategoryId)) {
      closeMegaMenu();
    }
  }, [activeCategoryId, categories]);

  useEffect(() => {
    if (activeCategory) {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      setRenderedCategory(activeCategory);
    }
  }, [activeCategory]);

  useEffect(() => {
    if (activeCategoryId !== null || !renderedCategory) return;

    const timeout = setTimeout(() => {
      setRenderedCategory(null);
      closeTimeoutRef.current = null;
    }, 220);
    closeTimeoutRef.current = timeout;

    return () => {
      clearTimeout(timeout);
      if (closeTimeoutRef.current === timeout) {
        closeTimeoutRef.current = null;
      }
    };
  }, [activeCategoryId, renderedCategory]);

  useEffect(() => {
    if (!activeCategoryId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      closeMegaMenu();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [activeCategoryId]);

  const handleRootBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) return;
    closeMegaMenu();
  };

  const handleRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      closeMegaMenu();
    }
  };

  const isActiveHref = (href: string) => isActiveNavHref(href, pathname, searchParams);

  if (loading) {
    return (
      <nav className="bg-stone-50/80 py-3">
        <StorefrontContainer className="flex items-center justify-center gap-4">
          <div className="skeleton-shimmer-light h-5 w-24 rounded"></div>
          <div className="skeleton-shimmer-light h-5 w-24 rounded"></div>
          <div className="skeleton-shimmer-light h-5 w-24 rounded"></div>
        </StorefrontContainer>
      </nav>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="desktop-nav-root"
      className="relative z-[120]"
      onBlur={handleRootBlur}
      onKeyDown={handleRootKeyDown}
      onPointerLeave={closeMegaMenu}
      onPointerEnter={() => {
        if (activeCategory) setActiveCategoryId(activeCategory.id);
      }}
    >
      <nav className="relative z-[120] bg-stone-50/80 py-3" aria-label="منوی اصلی فروشگاه">
        <StorefrontContainer className="flex items-center justify-center gap-4">
          {navItems.map((item) => {
            const isActive = isActiveHref(item.href);
            const isCategoryActive =
              Boolean(item.category) && item.category?.id === activeCategoryId;
            return (
              <Link
                key={item.key}
                href={item.href}
                prefetch={false}
                aria-current={isActive ? "page" : undefined}
                aria-haspopup={item.category ? "menu" : undefined}
                aria-expanded={item.category ? isCategoryActive : undefined}
                data-testid={item.category ? "desktop-nav-category" : undefined}
                onFocus={() => {
                  if (item.category) {
                    setActiveCategoryId(item.category.id);
                  } else {
                    closeMegaMenu();
                  }
                }}
                onPointerEnter={() => {
                  if (item.category) {
                    setActiveCategoryId(item.category.id);
                  } else {
                    closeMegaMenu();
                  }
                }}
                onClick={closeMegaMenu}
                className={[
                  "pressable flex items-center gap-1 rounded-full text-sm underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white",
                  isActive
                    ? "bg-infinity-primary-lighter/20 px-3 py-1 text-infinity-primary"
                    : "text-neutral-800 transition-colors hover:text-infinity-primary",
                  isCategoryActive && !isActive ? "text-infinity-primary" : "",
                ].join(" ")}
              >
                {item.label}
                {item.icon === "sale" && <SaleBadgeIcon className="h-5 w-5 shrink-0" />}
                {item.category && <ChevronDownIcon />}
              </Link>
            );
          })}
        </StorefrontContainer>
      </nav>

      {megaMenuCategory && (
        <>
          <div
            className="storefront-mega-backdrop pointer-events-none fixed inset-x-0 bottom-0 z-[100] bg-black/35 backdrop-blur-[3px]"
            style={{ top: "var(--header-offset, 82px)" }}
            data-state={activeCategory ? "open" : "closed"}
            data-testid="desktop-mega-menu-backdrop"
            aria-hidden
          />
          <div
            className="storefront-mega-panel absolute left-0 right-0 top-full z-[110] overflow-hidden"
            data-state={activeCategory ? "open" : "closed"}
            onAnimationEnd={() => {
              if (!activeCategory) {
                if (closeTimeoutRef.current) {
                  clearTimeout(closeTimeoutRef.current);
                  closeTimeoutRef.current = null;
                }
                setRenderedCategory(null);
              }
            }}
          >
            <DesktopMegaMenu category={megaMenuCategory} onLinkClick={closeMegaMenu} />
          </div>
        </>
      )}
    </div>
  );
}
