"use client";

import NoData from "./NoData";
import { getProductCategories, type ProductCategorySummary } from "@/services/product/categories";
import { faNum } from "@/utils/faNum";
import type { ProductCardProps } from "@/components/Product/Card";
import Filter from "./List/Filter";
import PLPListMobileFilter from "./List/MobileFilter";
import HeartIcon from "./Icons/HeartIcon";
import DiscountIcon from "./Icons/DiscountIcon";
import SidebarSuggestions from "./List/SidebarSuggestions";
import Pagination from "./Pagination";
import { useQueryStates } from "nuqs";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SORT_LABELS } from "./sortOptions";
import { useSidebarProducts } from "@/hooks/useSidebarProducts";
import PLPDesktopList from "./List/PLPDesktopList";
import type { PLPProduct, PLPPagination } from "./types";
import { plpQueryOptions, plpQueryParsers } from "./queryState";
import { getPlpHref } from "@/utils/plpRoutes";
import { ProductResultsSkeleton } from "@/components/Skeletons/ProductListSkeleton";
import { scrollIntoViewWithOffset } from "@/utils/scroll";

const humanize = (value: string) =>
  value.toString().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

interface PLPListProps {
  products: PLPProduct[];
  pagination: PLPPagination;
  category?: string;
  /** All categories with parentId (for resolving category + children in filter). */
  allCategories?: ProductCategorySummary[];
  searchQuery?: string;
  discountedSidebarProducts?: ProductCardProps[];
  suggestedSidebarProducts?: ProductCardProps[];
  /** When provided, rendered in the sidebar instead of default suggestions (e.g. Suspense + AsyncSidebarProducts). */
  sidebarSlot?: React.ReactNode;
}

export default function PLPList({
  products: initialProducts,
  pagination: initialPagination,
  category: initialCategory,
  allCategories: allCategoriesProp = [],
  searchQuery,
  discountedSidebarProducts = [],
  suggestedSidebarProducts = [],
  sidebarSlot,
}: PLPListProps) {
  const [query, setQuery] = useQueryStates(plpQueryParsers, plpQueryOptions);
  const [isPagePending, startPageTransition] = useTransition();
  const pendingPageScrollRef = useRef<number | null>(null);
  const {
    available,
    minPrice,
    maxPrice,
    size,
    material,
    season,
    gender,
    usage,
    page,
    sort,
    hasDiscount: discountOnly,
  } = query;
  const router = useRouter();
  const searchParams = useSearchParams();

  const products = initialProducts;

  const [categoryOptions, setCategoryOptions] = useState<ProductCategorySummary[]>([]);
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);

  // When server passed allCategories (e.g. category PLP), use them for filter and skip client fetch.
  useEffect(() => {
    if (allCategoriesProp.length > 0) {
      setCategoryOptions(allCategoriesProp);
      return;
    }
    const fetchCategories = async () => {
      try {
        setIsLoadingCategories(true);
        const categories = await getProductCategories({ sort: "Title:asc" });
        if (!categories || categories.length === 0) {
          setCategoryOptions([]);
          return;
        }
        setCategoryOptions(categories);
      } catch (error) {
        console.error("[PLP] Error fetching categories:", error);
        setCategoryOptions([]);
      } finally {
        setIsLoadingCategories(false);
      }
    };
    fetchCategories();
  }, [allCategoriesProp]);

  const { sidebarProducts, mappedDiscountedSidebar, mappedSuggestedSidebar } = useSidebarProducts({
    validProducts: products,
    discountedSidebarProducts,
    suggestedSidebarProducts,
  });

  const sidebarContent = sidebarSlot ?? (
    <>
      <SidebarSuggestions
        key="suggested-sidebar"
        title="شاید بپسندید"
        icon={<HeartIcon />}
        items={mappedSuggestedSidebar.length > 0 ? mappedSuggestedSidebar : sidebarProducts}
      />
      <SidebarSuggestions
        key="discounted-sidebar"
        title="تخفیف های آخرماه"
        icon={<DiscountIcon />}
        items={mappedDiscountedSidebar.length > 0 ? mappedDiscountedSidebar : sidebarProducts}
      />
    </>
  );

  const selectedCategoryTitle = useMemo(() => {
    if (!initialCategory) return null;

    const option = categoryOptions.find(
      (item) => item.slug === initialCategory || String(item.id) === initialCategory,
    );
    if (option) return option.name || option.slug || String(option.id);

    const dynamicMatch = products.find(
      (product) =>
        product.attributes.product_main_category?.data?.attributes?.Slug === initialCategory ||
        product.attributes.product_main_category?.data?.attributes?.Title === initialCategory,
    );

    if (dynamicMatch?.attributes.product_main_category?.data?.attributes?.Title) {
      return dynamicMatch.attributes.product_main_category.data.attributes.Title;
    }

    return initialCategory.replace(/[-_]/g, " ");
  }, [initialCategory, categoryOptions, products]);

  const activeFilters = useMemo(() => {
    const filters: Array<{ key: string; label: string; onRemove: () => void }> = [];

    if (available === "true") {
      filters.push({
        key: "available",
        label: "فقط کالاهای موجود",
        onRemove: () => {
          void setQuery({ available: null, page: 1 });
        },
      });
    }

    if (initialCategory) {
      filters.push({
        key: "category",
        label: `دسته: ${selectedCategoryTitle || initialCategory}`,
        onRemove: () => {
          router.push(getPlpHref(searchParams));
        },
      });
    }

    if (discountOnly === "true") {
      filters.push({
        key: "discount",
        label: "فقط با تخفیف",
        onRemove: () => {
          void setQuery({ hasDiscount: null, page: 1 });
        },
      });
    }

    if (minPrice || maxPrice) {
      const minLabel = minPrice ? `از ${faNum(Number(minPrice))}` : "";
      const maxLabel = maxPrice ? `تا ${faNum(Number(maxPrice))}` : "";
      filters.push({
        key: "price",
        label: `قیمت ${[minLabel, maxLabel].filter(Boolean).join(" ") || ""}`.trim(),
        onRemove: () => {
          void setQuery({ minPrice: null, maxPrice: null, page: 1 });
        },
      });
    }

    if (size) {
      const numericSize = Number(size);
      const sizeLabel = Number.isNaN(numericSize) ? size : faNum(numericSize);
      filters.push({
        key: "size",
        label: `سایز ${sizeLabel}`,
        onRemove: () => {
          void setQuery({ size: null, page: 1 });
        },
      });
    }

    if (material) {
      filters.push({
        key: "material",
        label: `جنس: ${humanize(material)}`,
        onRemove: () => {
          void setQuery({ material: null, page: 1 });
        },
      });
    }

    if (season) {
      filters.push({
        key: "season",
        label: `فصل: ${humanize(season)}`,
        onRemove: () => {
          void setQuery({ season: null, page: 1 });
        },
      });
    }

    if (gender) {
      filters.push({
        key: "gender",
        label: `جنسیت: ${humanize(gender)}`,
        onRemove: () => {
          void setQuery({ gender: null, page: 1 });
        },
      });
    }

    if (usage) {
      filters.push({
        key: "usage",
        label: `کاربری: ${humanize(usage)}`,
        onRemove: () => {
          void setQuery({ usage: null, page: 1 });
        },
      });
    }

    if (sort) {
      filters.push({
        key: "sort",
        label: `مرتب‌سازی: ${SORT_LABELS[sort] || humanize(sort)}`,
        onRemove: () => {
          void setQuery({ sort: null, page: 1 });
        },
      });
    }

    return filters;
  }, [
    available,
    discountOnly,
    gender,
    initialCategory,
    material,
    maxPrice,
    minPrice,
    router,
    season,
    selectedCategoryTitle,
    searchParams,
    setQuery,
    size,
    sort,
    usage,
  ]);

  const clearAllFilters = () => {
    if (initialCategory) {
      router.push("/plp");
      return;
    }

    void setQuery({
      available: null,
      minPrice: null,
      maxPrice: null,
      size: null,
      material: null,
      season: null,
      gender: null,
      usage: null,
      hasDiscount: null,
      sort: null,
      page: 1,
    });
  };

  const scrollToPLPTop = useCallback(() => {
    if (typeof window === "undefined") return;
    const anchor = document.querySelector<HTMLElement>("[data-plp-top]");
    if (anchor) {
      scrollIntoViewWithOffset(anchor);
      return;
    }

    scrollIntoViewWithOffset(null, { fallbackTop: 0 });
  }, []);

  const scheduleScrollToPLPTop = useCallback(() => {
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(scrollToPLPTop);
  }, [scrollToPLPTop]);

  const handlePageChange = (nextPage: number) => {
    pendingPageScrollRef.current = nextPage;
    void setQuery(
      { page: nextPage },
      {
        ...plpQueryOptions,
        startTransition: startPageTransition,
      },
    );
    scheduleScrollToPLPTop();
  };

  useEffect(() => {
    if (isPagePending || pendingPageScrollRef.current !== page) return;

    pendingPageScrollRef.current = null;
    scheduleScrollToPLPTop();
  }, [isPagePending, page, scheduleScrollToPLPTop]);

  return (
    <div className="w-full" data-plp-top style={{ scrollMarginTop: "var(--header-offset, 88px)" }}>
      <div className="flex flex-col gap-4 md:flex-row">
        {/* Sidebar with filters - Desktop only */}
        <div className="hidden md:flex md:w-[280px]">
          <div
            className="sticky flex w-full flex-col gap-7"
            style={{ top: "calc(var(--header-offset, 88px) + 1.5rem)" }}
          >
            <Filter
              showAvailableOnly={available === "true"}
              categories={categoryOptions}
              isLoadingCategories={isLoadingCategories}
              selectedCategory={initialCategory}
            />

            {sidebarContent}
          </div>
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          {/* Mobile filter buttons */}
          <div className="mb-4 md:hidden">
            <PLPListMobileFilter
              categories={categoryOptions}
              isLoadingCategories={isLoadingCategories}
              selectedCategory={initialCategory}
            />
          </div>

          {/* Show search results title if search query exists */}
          {searchQuery && (
            <div className="mb-6">
              <h2 className="text-xl font-semibold">نتایج جستجو برای: &quot;{searchQuery}&quot;</h2>
            </div>
          )}

          {activeFilters.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-sm">
              {activeFilters.map((filterEntry) => (
                <button
                  key={`${filterEntry.key}-${filterEntry.label}`}
                  type="button"
                  onClick={filterEntry.onRemove}
                  className="group flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:border-infinity-primary-lighter hover:text-infinity-primary"
                >
                  <span>{filterEntry.label}</span>
                  <span className="text-base leading-none text-slate-400 transition-colors group-hover:text-infinity-primary">
                    &times;
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={clearAllFilters}
                className="text-xs font-medium text-infinity-primary hover:text-infinity-primary-dark"
              >
                حذف همه
              </button>
            </div>
          )}

          {products.length === 0 ? (
            <NoData category={initialCategory} searchQuery={searchQuery} />
          ) : (
            <>
              {isPagePending ? (
                <ProductResultsSkeleton />
              ) : (
                <PLPDesktopList products={products} />
              )}

              {/* Pagination */}
              <Pagination
                currentPage={page}
                totalPages={initialPagination.pageCount}
                onPageChange={handlePageChange}
                disabled={isPagePending}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
