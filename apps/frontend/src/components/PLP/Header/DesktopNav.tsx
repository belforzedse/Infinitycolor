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
import {
  buildStorefrontMenuTaxonomy,
  type StorefrontMenuTaxonomyItem,
} from "@/utils/storefrontMenuTaxonomy";

type MenuItem = StorefrontMenuTaxonomyItem<ProductCategorySummary>;

type NavItem =
  | {
      kind: "link";
      key: string;
      label: string;
      href: string;
      icon?: "sale";
    }
  | {
      kind: "taxonomy";
      key: string;
      label: string;
      href?: string;
      item: MenuItem;
      hasChildren: boolean;
    };

function getMenuItemLabel(item: MenuItem): string {
  return item.type === "group" ? item.label : item.category.name;
}

function menuItemHasChildren(item: MenuItem): boolean {
  return item.type === "group"
    ? item.categories.length > 0
    : Boolean(item.category.children?.length);
}

function categoryTreeIsActive(
  category: ProductCategorySummary,
  pathname: string,
  searchParams: URLSearchParams,
): boolean {
  if (isActiveNavHref(getCategoryPlpHref(category.slug), pathname, searchParams)) return true;
  return (category.children ?? []).some((child) =>
    categoryTreeIsActive(child, pathname, searchParams),
  );
}

function menuItemIsActive(
  item: MenuItem,
  pathname: string,
  searchParams: URLSearchParams,
): boolean {
  return item.type === "group"
    ? item.categories.some((category) => categoryTreeIsActive(category, pathname, searchParams))
    : categoryTreeIsActive(item.category, pathname, searchParams);
}

export default function PLPHeaderDesktopNav() {
  const { categories: catalogCategories, isLoading: loading } = useProductCategories({
    navigationSource: "catalog",
    includeChildren: true,
  });
  const categories = useMemo(
    () => withHeaderExtraCategories(catalogCategories),
    [catalogCategories],
  );
  const taxonomyItems = useMemo(() => buildStorefrontMenuTaxonomy(categories), [categories]);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextFocusOpenRef = useRef(false);
  const [activeMenuKey, setActiveMenuKey] = useState<string | null>(null);
  const [renderedMenuItem, setRenderedMenuItem] = useState<MenuItem | null>(null);

  const navItems: NavItem[] = useMemo(
    () => [
      { kind: "link", key: "home", label: "خانه", href: "/" },
      { kind: "link", key: "shop", label: "فروشگاه", href: "/plp" },
      ...taxonomyItems.map((item) => ({
        kind: "taxonomy" as const,
        key: `taxonomy-${item.key}`,
        label: getMenuItemLabel(item),
        href: item.type === "category" ? getCategoryPlpHref(item.category.slug) : undefined,
        item,
        hasChildren: menuItemHasChildren(item),
      })),
      {
        kind: "link",
        key: OPPSI_HEADER_ITEM.key,
        label: OPPSI_HEADER_ITEM.label,
        href: OPPSI_HEADER_ITEM.href,
      },
      {
        kind: "link",
        key: "discounts",
        label: "تخفیف‌ها",
        href: "/plp?hasDiscount=true",
        icon: "sale" as const,
      },
      { kind: "link", key: "blog", label: "مقالات", href: "/blog" },
    ],
    [taxonomyItems],
  );

  const activeMenuItem = taxonomyItems.find((item) => item.key === activeMenuKey) ?? null;
  const megaMenuItem = activeMenuItem ?? renderedMenuItem;

  const closeMegaMenu = () => setActiveMenuKey(null);

  const openMegaMenu = (item: MenuItem) => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setRenderedMenuItem(item);
    setActiveMenuKey(item.key);
  };

  const openMenuFromFocus = (item: MenuItem) => {
    if (suppressNextFocusOpenRef.current) {
      suppressNextFocusOpenRef.current = false;
      return;
    }
    openMegaMenu(item);
  };

  useEffect(() => {
    if (activeMenuKey !== null || !renderedMenuItem) return;

    const timeout = setTimeout(() => {
      setRenderedMenuItem(null);
      closeTimeoutRef.current = null;
    }, 220);
    closeTimeoutRef.current = timeout;

    return () => {
      clearTimeout(timeout);
      if (closeTimeoutRef.current === timeout) closeTimeoutRef.current = null;
    };
  }, [activeMenuKey, renderedMenuItem]);

  useEffect(() => {
    if (!activeMenuKey) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      closeMegaMenu();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [activeMenuKey]);

  const handleRootBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) return;
    closeMegaMenu();
  };

  const handleRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || activeMenuKey === null) return;
    const triggerKey = activeMenuKey;
    event.preventDefault();
    closeMegaMenu();
    window.requestAnimationFrame(() => {
      const trigger = document.getElementById(`desktop-nav-menu-${triggerKey}`);
      if (trigger && document.activeElement !== trigger) {
        suppressNextFocusOpenRef.current = true;
        trigger.focus();
      }
    });
  };

  const isActiveHref = (href: string) => isActiveNavHref(href, pathname, searchParams);

  if (loading) {
    return (
      <nav className="bg-stone-50/80 py-3">
        <StorefrontContainer className="flex items-center justify-center gap-4">
          <div className="skeleton-shimmer-light h-5 w-24 rounded" />
          <div className="skeleton-shimmer-light h-5 w-24 rounded" />
          <div className="skeleton-shimmer-light h-5 w-24 rounded" />
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
    >
      <nav className="relative z-[120] bg-stone-50/80 py-3" aria-label="منوی اصلی فروشگاه">
        <StorefrontContainer className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 xl:gap-x-4">
          {navItems.map((item) => {
            if (item.kind === "link") {
              const isActive = isActiveHref(item.href);
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  prefetch={item.href === "/plp" ? undefined : false}
                  aria-current={isActive ? "page" : undefined}
                  onFocus={closeMegaMenu}
                  onPointerEnter={closeMegaMenu}
                  onClick={closeMegaMenu}
                  className={[
                    "pressable flex items-center gap-1 rounded-full text-sm underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white",
                    isActive
                      ? "bg-infinity-primary-lighter/20 px-3 py-1 text-infinity-primary"
                      : "text-neutral-800 transition-colors hover:text-infinity-primary",
                  ].join(" ")}
                >
                  {item.label}
                  {item.icon === "sale" && <SaleBadgeIcon className="h-5 w-5 shrink-0" />}
                </Link>
              );
            }

            const isExpanded = item.item.key === activeMenuKey;
            const isTreeActive = menuItemIsActive(item.item, pathname, searchParams);
            const className = [
              "pressable flex items-center gap-1 rounded-full text-sm underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white",
              isTreeActive
                ? "bg-infinity-primary-lighter/20 px-3 py-1 text-infinity-primary"
                : "text-neutral-800 transition-colors hover:text-infinity-primary",
              isExpanded && !isTreeActive ? "text-infinity-primary" : "",
            ].join(" ");

            if (!item.hasChildren && item.href) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  prefetch={false}
                  aria-current={isActiveHref(item.href) ? "page" : undefined}
                  data-testid="desktop-nav-category"
                  onFocus={closeMegaMenu}
                  onPointerEnter={closeMegaMenu}
                  onClick={closeMegaMenu}
                  className={className}
                >
                  {item.label}
                </Link>
              );
            }

            return (
              <button
                key={item.key}
                id={`desktop-nav-menu-${item.item.key}`}
                type="button"
                aria-haspopup="true"
                aria-expanded={isExpanded}
                data-testid="desktop-nav-category"
                onFocus={() => openMenuFromFocus(item.item)}
                onPointerEnter={() => openMegaMenu(item.item)}
                onClick={() => (isExpanded ? closeMegaMenu() : openMegaMenu(item.item))}
                className={className}
              >
                {item.label}
                <ChevronDownIcon />
              </button>
            );
          })}
        </StorefrontContainer>
      </nav>

      {megaMenuItem && (
        <>
          <div
            className="storefront-mega-backdrop pointer-events-none fixed inset-x-0 bottom-0 z-[100] bg-black/35 backdrop-blur-[3px]"
            style={{ top: "var(--header-offset, 82px)" }}
            data-state={activeMenuItem ? "open" : "closed"}
            data-testid="desktop-mega-menu-backdrop"
            aria-hidden
          />
          <div
            className="storefront-mega-panel absolute left-0 right-0 top-full z-[110] overflow-hidden"
            data-state={activeMenuItem ? "open" : "closed"}
            onAnimationEnd={() => {
              if (!activeMenuItem) {
                if (closeTimeoutRef.current) {
                  clearTimeout(closeTimeoutRef.current);
                  closeTimeoutRef.current = null;
                }
                setRenderedMenuItem(null);
                setActiveMenuKey(null);
              }
            }}
          >
            <DesktopMegaMenu
              key={megaMenuItem.key}
              item={megaMenuItem}
              onLinkClick={closeMegaMenu}
            />
          </div>
        </>
      )}
    </div>
  );
}
