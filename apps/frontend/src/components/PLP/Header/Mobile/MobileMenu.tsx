"use client";

import { Dialog } from "@headlessui/react";
import { ChevronDown, Search, X } from "lucide-react";
import { type AnimationEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useProductCategories } from "@/hooks/useProductCategories";
import { getCategoryPlpHref } from "@/utils/plpRoutes";
import type { ProductCategorySummary } from "@/services/product/categories";
import { useCart } from "@/contexts/CartContext";
import { useCartShellReady } from "@/hooks/useCartShellReady";
import OrderTrackingIcon from "@/components/PLP/Icons/OrderTrackingIcon";
import ShoppingCartIcon from "@/components/PLP/Icons/ShoppingCartIcon";
import UserProfileIcon from "@/components/PLP/Icons/UserProfileIcon";
import SaleBadgeIcon from "../SaleBadgeIcon";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSearchClick?: () => void;
}

type MobileNavItem =
  | {
      key: string;
      label: string;
      href: string;
      type?: "link" | "sale";
    }
  | {
      key: string;
      label: string;
      href: string;
      type: "category";
      category: ProductCategorySummary;
    }
  | {
      key: string;
      label: string;
      type: "category-group";
      categories: ProductCategorySummary[];
    };

type MobileCategoryGroupDefinition = {
  key: string;
  label: string;
  terms: readonly string[];
};

const MOBILE_CATEGORY_GROUPS: readonly MobileCategoryGroupDefinition[] = [
  {
    key: "upper-body",
    label: "بالاتنه",
    terms: [
      "مانتو",
      "coat-and-mantle",
      "شومیز",
      "paperback-and-tonic",
      "پیراهن",
      "shirt",
    ],
  },
  {
    key: "lower-body",
    label: "پایین‌تنه",
    terms: ["شلوار", "pants", "دامن", "skirt"],
  },
  {
    key: "shoes-accessories",
    label: "کفش و اکسسوری",
    terms: [
      "انواع کفش",
      "کفش",
      "shoes",
      "شال",
      "shawls-and-scarves",
      "جوراب",
      "socks",
    ],
  },
  {
    key: "mens-clothing",
    label: "لباس مردانه",
    terms: [
      "لباس مردانه",
      "مردانه",
      "mens-clothing",
      "men-clothing",
      "mens",
    ],
  },
  {
    key: "other-clothing",
    label: "سایر لباس‌ها",
    terms: [
      "لباس‌های زمستانه",
      "لباس زمستانه",
      "winter",
      "لباس زیر",
      "under-wear",
      "راحتی",
      "house-dress",
    ],
  },
];

const FALLBACK_MOBILE_CATEGORY_GROUP_KEY = "other-clothing";

const normalizeCategoryText = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase("fa-IR")
    .replace(/\u200c/g, " ")
    .replace(/\s+/g, " ");

function categoryMatchesGroup(
  category: ProductCategorySummary,
  group: MobileCategoryGroupDefinition,
) {
  const name = normalizeCategoryText(category.name);
  const slug = normalizeCategoryText(category.slug);

  return group.terms.some((term) => {
    const normalizedTerm = normalizeCategoryText(term);
    return (
      name === normalizedTerm ||
      name.includes(normalizedTerm) ||
      slug === normalizedTerm ||
      slug.includes(normalizedTerm)
    );
  });
}

function buildMobileCategoryGroups(categories: ProductCategorySummary[]) {
  const grouped = new Map<string, ProductCategorySummary[]>(
    MOBILE_CATEGORY_GROUPS.map((group) => [group.key, []]),
  );

  for (const category of categories) {
    const matchingGroup =
      MOBILE_CATEGORY_GROUPS.find((group) => categoryMatchesGroup(category, group)) ??
      MOBILE_CATEGORY_GROUPS.find((group) => group.key === FALLBACK_MOBILE_CATEGORY_GROUP_KEY);

    if (!matchingGroup) continue;
    grouped.get(matchingGroup.key)?.push(category);
  }

  return MOBILE_CATEGORY_GROUPS.map((group) => ({
    ...group,
    categories: grouped.get(group.key) ?? [],
  })).filter((group) => group.categories.length > 0);
}

function MobileMenuSkeleton() {
  return (
    <div className="space-y-2">
      <div className="skeleton-shimmer-light h-10 rounded-[10px]" />
      <div className="skeleton-shimmer-light h-10 rounded-[10px]" />
      <div className="skeleton-shimmer-light h-10 rounded-[10px]" />
      <div className="skeleton-shimmer-light h-10 rounded-[10px]" />
    </div>
  );
}

export default function MobileMenu({ isOpen, onClose, onSearchClick }: Props) {
  const pathname = usePathname();
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);
  const [expandedCategoryId, setExpandedCategoryId] = useState<number | null>(null);
  const [menuState, setMenuState] = useState<"closed" | "open" | "closing">("closed");
  const { totalItems, openDrawer } = useCart();
  const isCartShellReady = useCartShellReady();
  const visibleTotalItems = isCartShellReady ? totalItems : 0;
  const { categories, isLoading: loading } = useProductCategories({
    navbarAssignedOnly: true,
    includeChildren: true,
    enabled: isOpen,
  });

  const mobileCategoryGroups = useMemo(() => buildMobileCategoryGroups(categories), [categories]);

  const menuItems: MobileNavItem[] = useMemo(
    () => [
      { key: "home", label: "خانه", href: "/" },
      { key: "shop", label: "فروشگاه", href: "/plp" },
      ...mobileCategoryGroups.map((group) => ({
        key: `category-group-${group.key}`,
        label: group.label,
        type: "category-group" as const,
        categories: group.categories,
      })),
      {
        key: "discounts",
        label: "تخفیف‌ها و جشنواره‌ها",
        href: "/plp?hasDiscount=true",
        type: "sale" as const,
      },
      { key: "blog", label: "مقالات", href: "/blog" },
    ],
    [mobileCategoryGroups],
  );

  useEffect(() => {
    if (isOpen) {
      setMenuState("open");
      return;
    }

    setMenuState((current) => (current === "closed" ? "closed" : "closing"));
  }, [isOpen]);

  useEffect(() => {
    if (menuState === "closed") {
      setExpandedGroupKey(null);
      setExpandedCategoryId(null);
    }
  }, [menuState]);

  const requestClose = () => {
    setMenuState("closing");
  };

  const handlePanelAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target || menuState !== "closing") return;
    setMenuState("closed");
    onClose();
  };

  const isActiveHref = (href: string) => {
    if (href === "/") return pathname === "/";
    const pathOnly = href.split("?")[0];
    return decodeURI(pathname) === decodeURI(pathOnly);
  };

  const handleSearchClick = () => {
    onClose();
    window.setTimeout(() => onSearchClick?.(), 0);
  };

  const handleCartClick = () => {
    onClose();
    window.setTimeout(openDrawer, 0);
  };

  const toggleGroup = (groupKey: string) => {
    setExpandedGroupKey((current) => {
      const nextGroupKey = current === groupKey ? null : groupKey;
      if (nextGroupKey !== current) {
        setExpandedCategoryId(null);
      }
      return nextGroupKey;
    });
  };

  const renderLink = (item: Extract<MobileNavItem, { type?: "link" | "sale" }>) => {
    const isSale = item.type === "sale";
    return (
      <Link
        key={item.key}
        href={item.href}
        onClick={onClose}
        aria-current={isActiveHref(item.href) ? "page" : undefined}
        className={[
          "pressable flex h-10 w-full items-center justify-between rounded-[10px] bg-[#FAFAF9] px-3 text-right text-sm font-medium text-neutral-800 transition-colors hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white",
          isActiveHref(item.href) ? "text-infinity-primary" : "",
        ].join(" ")}
      >
        <span className="truncate">{item.label}</span>
        {isSale && <SaleBadgeIcon className="h-5 w-5 shrink-0" />}
      </Link>
    );
  };

  const renderCategory = (item: Extract<MobileNavItem, { type: "category" }>, nested = false) => {
    const children = item.category.children ?? [];
    const hasChildren = children.length > 0;
    const isExpanded = expandedCategoryId === item.category.id;
    const rowBackground = nested ? "bg-white" : "bg-[#FAFAF9]";
    const rowPadding = nested ? "px-4" : "px-3";

    if (!hasChildren) {
      return (
        <Link
          key={item.key}
          href={item.href}
          onClick={onClose}
          aria-current={isActiveHref(item.href) ? "page" : undefined}
          className={[
            "flex h-10 w-full items-center justify-between rounded-[10px] text-right text-sm font-medium text-neutral-800 transition-colors hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            rowBackground,
            rowPadding,
            isActiveHref(item.href) ? "text-infinity-primary" : "",
          ].join(" ")}
        >
          <span className="truncate">{item.label}</span>
        </Link>
      );
    }

    return (
      <div key={item.key} className="overflow-hidden rounded-[10px]">
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() =>
            setExpandedCategoryId((current) =>
              current === item.category.id ? null : item.category.id,
            )
          }
          className={[
            "flex h-10 w-full items-center justify-between text-right text-sm font-medium text-neutral-800 transition-colors hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            rowBackground,
            rowPadding,
            isExpanded ? "text-infinity-primary" : "",
          ].join(" ")}
        >
          <span className="flex min-w-0 items-center gap-2">
            {isExpanded && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-infinity-primary" />
            )}
            <span className="truncate">{item.label}</span>
          </span>
          <ChevronDown
            className={[
              "h-4 w-4 shrink-0 text-infinity-primary transition-transform duration-200",
              isExpanded ? "rotate-180" : "",
            ].join(" ")}
            aria-hidden="true"
          />
        </button>

        <div
          className="storefront-mobile-category-panel bg-white"
          data-state={isExpanded ? "open" : "closed"}
        >
          <div className="storefront-mobile-category-panel-inner min-h-0 overflow-hidden">
            {children.map((child) => (
              <Link
                key={child.id}
                href={getCategoryPlpHref(child.slug)}
                onClick={onClose}
                className="block border-t border-stone-100 px-3 py-3 text-right text-sm font-medium text-neutral-700 transition-colors hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-infinity-primary"
              >
                <span className="block truncate">{child.name}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderCategoryGroup = (item: Extract<MobileNavItem, { type: "category-group" }>) => {
    const isExpanded = expandedGroupKey === item.key;

    return (
      <div
        key={item.key}
        className="overflow-hidden rounded-[10px] bg-[#FAFAF9]"
        data-testid={item.key}
      >
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => toggleGroup(item.key)}
          className={[
            "flex h-10 w-full items-center justify-between px-3 text-right text-sm font-medium text-neutral-800 transition-colors hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            isExpanded ? "text-infinity-primary" : "",
          ].join(" ")}
        >
          <span className="flex min-w-0 items-center gap-2">
            {isExpanded && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-infinity-primary" />
            )}
            <span className="truncate">{item.label}</span>
          </span>
          <ChevronDown
            className={[
              "h-4 w-4 shrink-0 text-infinity-primary transition-transform duration-200",
              isExpanded ? "rotate-180" : "",
            ].join(" ")}
            aria-hidden="true"
          />
        </button>

        <div
          className="storefront-mobile-category-panel bg-white"
          data-state={isExpanded ? "open" : "closed"}
        >
          <div className="storefront-mobile-category-panel-inner min-h-0 overflow-hidden">
            <div className="space-y-1 border-t border-stone-100 bg-white py-2 pr-3">
              {item.categories.map((category) =>
                renderCategory(
                  {
                    key: `category-${category.id}`,
                    label: category.name,
                    href: getCategoryPlpHref(category.slug),
                    type: "category",
                    category,
                  },
                  true,
                ),
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (menuState === "closed") return null;

  return (
    <Dialog static open as="div" className="relative z-[1400]" onClose={requestClose}>
      <div
        className="storefront-mobile-menu-backdrop fixed inset-0 bg-black/45 backdrop-blur-[2px]"
        data-state={menuState === "closing" ? "closed" : "open"}
        aria-hidden="true"
      />

      <div
        className="fixed inset-x-0 top-0 flex justify-center px-0"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <Dialog.Panel className="contents">
          <div
            className="storefront-mobile-menu-panel mt-1 max-h-[calc(100dvh-1.25rem)] w-full overflow-y-auto rounded-b-[18px] bg-white px-0 shadow-[0_20px_60px_rgba(15,23,42,0.22)] outline-none"
            data-state={menuState === "closing" ? "closed" : "open"}
            style={{
              paddingBottom: "calc(env(safe-area-inset-bottom) + 1.25rem)",
            }}
            onAnimationEnd={handlePanelAnimationEnd}
          >
            <Dialog.Title className="sr-only">منوی فروشگاه</Dialog.Title>

            <div className="flex min-h-[4.25rem] items-center gap-2 px-5 py-2" dir="ltr">
              <button
                type="button"
                onClick={handleCartClick}
                className="pressable relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-infinity-primary text-white transition-colors hover:bg-infinity-primary-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                aria-label="Cart"
              >
                <ShoppingCartIcon className="h-5 w-5 [&_path]:stroke-white" />
                {visibleTotalItems > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-white bg-infinity-primary-dark px-1 text-[10px] font-medium leading-none text-white">
                    {visibleTotalItems > 9 ? "9+" : visibleTotalItems}
                  </span>
                )}
              </button>

              <Link
                href="/orders"
                onClick={onClose}
                className="pressable inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 text-xs font-medium text-neutral-700 transition-colors hover:bg-stone-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                dir="rtl"
              >
                <OrderTrackingIcon className="h-4 w-4 shrink-0" />
                <span>پیگیری سفارش</span>
              </Link>

              <div className="ml-auto flex items-center gap-2">
                <Link
                  href="/auth/login"
                  onClick={onClose}
                  className="pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-neutral-600 transition-colors hover:bg-stone-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                  aria-label="Login"
                >
                  <UserProfileIcon className="h-4 w-4" />
                </Link>

                <button
                  type="button"
                  onClick={requestClose}
                  className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-neutral-600 transition-colors hover:bg-stone-50 hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                  aria-label="Close menu"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="px-5 pb-5">
              <button
                type="button"
                onClick={handleSearchClick}
                className="pressable mb-3 flex h-9 w-full items-center justify-between border-b border-stone-100 bg-white px-0 text-sm text-neutral-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <span>دنبال چی می‌گردی؟</span>
                <Search className="h-5 w-5 text-infinity-primary" aria-hidden="true" />
              </button>

              <nav
                className="space-y-2"
                aria-label="منوی موبایل فروشگاه"
              >
                {loading ? (
                  <MobileMenuSkeleton />
                ) : (
                  menuItems.map((item) =>
                    item.type === "category"
                      ? renderCategory(item)
                      : item.type === "category-group"
                        ? renderCategoryGroup(item)
                        : renderLink(item),
                  )
                )}
              </nav>
            </div>
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
