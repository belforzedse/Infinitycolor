"use client";

import { Dialog } from "@headlessui/react";
import { ChevronDown, Search, X } from "lucide-react";
import { type AnimationEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useProductCategories } from "@/hooks/useProductCategories";
import { getCategoryPlpHref, isActiveNavHref } from "@/utils/plpRoutes";
import type { ProductCategorySummary } from "@/services/product/categories";
import { useCart } from "@/contexts/CartContext";
import { useCartShellReady } from "@/hooks/useCartShellReady";
import { API_BASE_URL } from "@/constants/api";
import { OPPSI_HEADER_ITEM } from "@/constants/categories";
import { withHeaderExtraCategories } from "@/utils/headerExtraCategories";
import {
  buildStorefrontMenuTaxonomy,
  getViewAllCategoryLabel,
  isSyntheticStorefrontMenuCategory,
} from "@/utils/storefrontMenuTaxonomy";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import SearchSuggestionCard from "@/components/Search/SearchSuggestionCard";
import OrderTrackingIcon from "@/components/PLP/Icons/OrderTrackingIcon";
import ShoppingCartIcon from "@/components/PLP/Icons/ShoppingCartIcon";
import AccountAccessMenu from "@/components/PLP/Header/AccountAccessMenu";
import MobileWalletBalance from "@/components/PLP/Header/Mobile/MobileWalletBalance";
import SaleBadgeIcon from "../SaleBadgeIcon";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  focusSearchOnOpen?: boolean;
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

type SearchSuggestion = {
  id: number;
  slug?: string;
  Title: string;
  Price?: number;
  DiscountPrice?: number;
  Discount?: number;
  category?: string;
  image?: string;
  isAvailable?: boolean;
};

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

function MobileSearchSkeleton() {
  return (
    <div className="space-y-2 py-1" dir="rtl">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 p-3">
          <div className="skeleton-shimmer h-12 w-12 rounded-xl" />
          <div className="flex-1 space-y-2">
            <div className="skeleton-shimmer-light h-3 w-2/3 rounded" />
            <div className="skeleton-shimmer-light h-3 w-1/3 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MobileMenu({ isOpen, onClose, focusSearchOnOpen = false }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);
  const [expandedCategoryId, setExpandedCategoryId] = useState<number | null>(null);
  const [menuState, setMenuState] = useState<"closed" | "open" | "closing">("closed");
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const finishingCloseRef = useRef(false);

  const trimmedQuery = searchQuery.trim();
  const hasQuery = trimmedQuery.length > 0;
  const isSearchActive = trimmedQuery.length >= 2;
  const { totalItems, openDrawer } = useCart();
  const isCartShellReady = useCartShellReady();
  const visibleTotalItems = isCartShellReady ? totalItems : 0;
  const { categories: catalogCategories, isLoading: loading } = useProductCategories({
    navigationSource: "catalog",
    includeChildren: true,
    enabled: isOpen,
  });
  const categories = useMemo(
    () => withHeaderExtraCategories(catalogCategories),
    [catalogCategories],
  );

  const taxonomyItems = useMemo(() => buildStorefrontMenuTaxonomy(categories), [categories]);

  const menuItems: MobileNavItem[] = useMemo(
    () => [
      { key: "home", label: "خانه", href: "/" },
      { key: "shop", label: "فروشگاه", href: "/plp" },
      ...taxonomyItems.map((item) =>
        item.type === "group"
          ? {
              key: `category-group-${item.key}`,
              label: item.label,
              type: "category-group" as const,
              categories: item.categories,
            }
          : {
              key: `category-${item.key}-${item.category.id}`,
              label: item.category.name,
              href: getCategoryPlpHref(item.category.slug),
              type: "category" as const,
              category: item.category,
            },
      ),
      {
        key: OPPSI_HEADER_ITEM.key,
        label: OPPSI_HEADER_ITEM.label,
        href: OPPSI_HEADER_ITEM.href,
      },
      {
        key: "discounts",
        label: "تخفیف‌ها",
        href: "/plp?hasDiscount=true",
        type: "sale" as const,
      },
      { key: "blog", label: "مقالات", href: "/blog" },
    ],
    [taxonomyItems],
  );

  useEffect(() => {
    if (isOpen) {
      // finishMenuClose() latches this ref, and only an `isOpen` transition
      // cleared it. Closing from a nav link flips `isOpen` false *before* the
      // exit animation ends, so the second onClose() inside finishMenuClose()
      // is a no-op, this effect never re-runs, and the latch outlives its
      // render — swallowing every later open and killing the menu for the rest
      // of the session. Clearing it here is enough: the effect only runs on an
      // `isOpen` transition, so it cannot fire on that in-between render.
      finishingCloseRef.current = false;
      setMenuState("open");
      return;
    }

    finishingCloseRef.current = false;
    setMenuState((current) => (current === "closed" ? "closed" : "closing"));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !focusSearchOnOpen || menuState !== "open") return;

    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus({ preventScroll: false });
    }, 150);

    return () => window.clearTimeout(timer);
  }, [focusSearchOnOpen, isOpen, menuState]);

  useEffect(() => {
    if (menuState === "closed") {
      setExpandedGroupKey(null);
      setExpandedCategoryId(null);
      setSearchQuery("");
      setSuggestions([]);
      setSearchLoading(false);
      setSearchError(false);
    }
  }, [menuState]);

  // Debounced inline product search. Mirrors the suggestion fetch used by
  // MobileSearch (same endpoint, 2-char minimum, 300ms debounce, abortable).
  useEffect(() => {
    if (menuState === "closed") return;

    let active = true;
    const controller = new AbortController();
    const q = trimmedQuery;

    if (q.length < 2) {
      setSuggestions([]);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }

    setSearchLoading(true);
    setSearchError(false);

    const timer = setTimeout(async () => {
      try {
        const url = `${API_BASE_URL}/products/search?q=${encodeURIComponent(q)}&page=1&pageSize=6&view=suggestion&_skip_global_loader=1`;
        const res = await fetch(url, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!active) return;
        const json = await res.json();
        const items: SearchSuggestion[] = (json?.data || []).map(
          (i: { id: number; attributes?: Record<string, unknown>; Title?: string }) => {
            const attrs = (i.attributes ? i.attributes : i) as Record<string, unknown>;
            const cover = attrs?.CoverImage as
              | {
                  url?: string;
                  formats?: { thumbnail?: { url?: string }; small?: { url?: string } };
                  data?: { attributes?: { url?: string } };
                }
              | undefined;
            const imagePath =
              cover?.formats?.thumbnail?.url ??
              cover?.url ??
              cover?.data?.attributes?.url ??
              undefined;
            return {
              id: i.id,
              slug: (attrs?.Slug as string | undefined) ?? undefined,
              Title: (attrs?.Title as string) ?? i.Title ?? "",
              Price: (attrs?.Price as number | undefined) ?? undefined,
              DiscountPrice: (attrs?.DiscountPrice as number | undefined) ?? undefined,
              Discount: (attrs?.Discount as number | undefined) ?? undefined,
              category:
                (attrs?.product_main_category as { Title?: string } | undefined)?.Title ??
                undefined,
              image: imagePath ? resolveAssetUrl(imagePath) || undefined : undefined,
              isAvailable: (attrs?.IsAvailable as boolean | undefined) ?? true,
            };
          },
        );
        setSuggestions(items);
        setSearchError(false);
      } catch (error) {
        if (!active || (error as Error)?.name === "AbortError") return;
        setSuggestions([]);
        setSearchError(true);
      } finally {
        if (active) setSearchLoading(false);
      }
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedQuery, menuState, retryNonce]);

  const requestClose = () => {
    setMenuState("closing");
  };

  const finishMenuClose = useCallback(() => {
    if (finishingCloseRef.current) return;
    finishingCloseRef.current = true;
    setMenuState("closed");
    onClose();
  }, [onClose]);

  const handlePanelAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target || menuState !== "closing") return;
    finishMenuClose();
  };

  const isActiveHref = (href: string) => isActiveNavHref(href, pathname, searchParams);

  const getSearchHref = (term: string) => {
    const basePath = pathname.startsWith("/plp/category/") ? pathname : "/plp";
    return `${basePath}?search=${encodeURIComponent(term)}`;
  };

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!isSearchActive) return;
    onClose();
    router.push(getSearchHref(trimmedQuery));
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    setSuggestions([]);
    setSearchError(false);
    searchInputRef.current?.focus();
  };

  const handleSuggestionClick = (suggestion: SearchSuggestion) => {
    onClose();
    router.push(`/pdp/${suggestion.slug || suggestion.id}`);
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
        prefetch={item.href === "/plp" ? undefined : false}
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
          prefetch={false}
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
            {!isSyntheticStorefrontMenuCategory(item.category) && (
              <Link
                href={item.href}
                prefetch={false}
                onClick={onClose}
                aria-current={isActiveHref(item.href) ? "page" : undefined}
                className={[
                  "block border-t border-stone-100 bg-infinity-primary-lighter/20 px-3 py-3 text-right text-sm font-semibold text-infinity-primary-dark transition-colors hover:bg-infinity-primary-lighter/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-infinity-primary",
                  isActiveHref(item.href) ? "text-infinity-primary" : "",
                ].join(" ")}
              >
                <span className="block truncate">{getViewAllCategoryLabel(item.label)}</span>
              </Link>
            )}
            {children.map((child) => (
              <Link
                key={child.id}
                href={getCategoryPlpHref(child.slug)}
                prefetch={false}
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
    const groupKey = item.key.replace(/^category-group-/, "");

    const viewAllLabels: Record<string, string> = {
      "upper-body": "مشاهده همه بالاتنه‌ها",
      "lower-body": "مشاهده همه پایین‌تنه‌ها",
      sportswear: "مشاهده همه لباس‌های ورزشی",
    };

    const viewAllLabel = viewAllLabels[groupKey] ?? getViewAllCategoryLabel(item.label);
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
            <Link
              href={`/plp?menuGroup=${encodeURIComponent(groupKey)}`}
              prefetch={false}
              onClick={onClose}
              className="block border-t border-stone-100 bg-infinity-primary-lighter/20 px-3 py-3 text-right text-sm font-semibold text-infinity-primary-dark transition-colors hover:bg-infinity-primary-lighter/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-infinity-primary"
            >
              <span className="block truncate">{viewAllLabel}</span>
            </Link>
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

  const renderSearchResults = () => {
    if (trimmedQuery.length < 2) {
      return (
        <div className="px-1 py-6 text-center text-sm text-neutral-400" dir="rtl">
          حداقل ۲ حرف وارد کنید
        </div>
      );
    }

    if (searchLoading) {
      return <MobileSearchSkeleton />;
    }

    if (searchError) {
      return (
        <div className="flex flex-col items-center gap-3 px-1 py-6 text-center" dir="rtl">
          <p className="text-sm text-neutral-500">جستجو با خطا مواجه شد.</p>
          <button
            type="button"
            onClick={() => setRetryNonce((n) => n + 1)}
            className="pressable rounded-full bg-infinity-primary-lighter/30 px-4 py-2 text-sm font-medium text-infinity-primary-darker transition-colors hover:bg-infinity-primary-lighter/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2"
          >
            تلاش دوباره
          </button>
        </div>
      );
    }

    if (suggestions.length === 0) {
      return (
        <div className="px-1 py-6 text-center text-sm text-neutral-500" dir="rtl">
          موردی یافت نشد
        </div>
      );
    }

    return (
      <div
        className="overflow-hidden rounded-2xl border border-stone-100 bg-white"
        dir="rtl"
        role="listbox"
        aria-label="نتایج جستجوی محصولات"
      >
        {suggestions.map((suggestion, index) => (
          <SearchSuggestionCard
            key={suggestion.id}
            id={suggestion.id}
            title={suggestion.Title}
            price={suggestion.Price}
            discountPrice={suggestion.DiscountPrice}
            discount={suggestion.Discount}
            category={suggestion.category}
            image={suggestion.image}
            isAvailable={suggestion.isAvailable}
            query={trimmedQuery}
            index={index}
            onClick={() => handleSuggestionClick(suggestion)}
          />
        ))}
        <button
          type="button"
          onClick={() => {
            onClose();
            router.push(getSearchHref(trimmedQuery));
          }}
          className="pressable block w-full border-t border-stone-100 bg-transparent px-3 py-2.5 text-right text-xs font-medium text-infinity-primary-dark transition-colors hover:bg-stone-50"
        >
          مشاهده همه نتایج
        </button>
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
        <Dialog.Panel
          className="storefront-mobile-menu-panel mt-1 max-h-[calc(100dvh-1.25rem)] w-full overflow-y-auto rounded-b-[18px] bg-white px-0 shadow-[0_20px_60px_rgba(15,23,42,0.22)] outline-none"
          data-state={menuState === "closing" ? "closed" : "open"}
          style={{
            paddingBottom: "calc(env(safe-area-inset-bottom) + 1.25rem)",
          }}
          onAnimationEnd={handlePanelAnimationEnd}
        >
          <Dialog.Title className="sr-only">منوی فروشگاه</Dialog.Title>

          <div
            className="sticky top-0 z-20 rounded-b-none border-b border-stone-100/80 bg-white/80 backdrop-blur-md supports-[backdrop-filter]:bg-white/70"
            data-adaptive-surface
          >
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

              <a
                href="/orders"
                onClick={onClose}
                className="pressable inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 text-xs font-medium text-neutral-700 transition-colors hover:bg-stone-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                dir="rtl"
              >
                <OrderTrackingIcon className="h-4 w-4 shrink-0" />
                <span>پیگیری سفارش</span>
              </a>

              <MobileWalletBalance isOpen={isOpen} onNavigate={onClose} />

              <div className="ml-auto flex items-center gap-2">
                <AccountAccessMenu
                  triggerAriaLabel="Account"
                  triggerClassName="pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-neutral-600 transition-colors hover:bg-stone-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                  triggerIconClassName="h-4 w-4"
                  menuAlign="center"
                  onNavigate={onClose}
                />

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

            <div className="px-5 pb-3" data-mobile-menu-search>
              <form onSubmit={handleSearchSubmit} className="relative" dir="rtl">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  inputMode="search"
                  enterKeyHint="search"
                  aria-label="جستجوی محصولات"
                  placeholder="دنبال چی می‌گردی؟"
                  dir="rtl"
                  className="h-9 w-full border-b border-stone-100 bg-transparent pl-8 pr-0 text-[16px] leading-6 text-neutral-800 placeholder:text-neutral-400 focus:border-infinity-primary focus:outline-none"
                />
                {hasQuery ? (
                  <button
                    type="button"
                    onClick={handleClearSearch}
                    aria-label="پاک کردن جستجو"
                    className="pressable absolute left-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-neutral-400 transition-colors hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : (
                  <span className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2">
                    <Search className="h-5 w-5 text-infinity-primary" aria-hidden="true" />
                  </span>
                )}
              </form>
            </div>
          </div>

          <div className="px-5 pb-5 pt-3">
            {hasQuery ? (
              renderSearchResults()
            ) : (
              <nav className="space-y-2" aria-label="منوی موبایل فروشگاه">
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
            )}
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
