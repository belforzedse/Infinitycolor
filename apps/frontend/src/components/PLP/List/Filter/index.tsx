"use client";

import PLPListFilterCategory from "./Category";
import AvailabilityFilter from "./Availability";
import PriceFilter from "./Price";
import SizeFilter from "./Size";
import ColorFilter from "./Color";
import PLPFilterBox from "@/components/Kits/PLP/FilterBox";
import { useQueryStates } from "nuqs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getProductCategories, type ProductCategorySummary } from "@/services/product/categories";
import {
  getProductVariationColors,
  getProductVariationSizes,
} from "@/services/product/variationAttributes";
import { SORT_OPTIONS } from "@/components/PLP/sortOptions";
import { plpQueryOptions, plpQueryParsers, toggleFilterValue } from "@/components/PLP/queryState";
import { getCategoryPlpHrefWithQuery } from "@/utils/plpRoutes";
import { buildSizeBuckets } from "@/utils/plpSizeFilter";
import { buildColorFamilyBuckets } from "@/utils/plpColorFilter";
import {
  applyCategoryFilterRuleToColors,
  applyCategoryFilterRuleToSizes,
  resolveCategoryFilterRule,
} from "@/utils/plpCategoryFilters";

interface FilterProps {
  showAvailableOnly?: boolean;
  categories?: ProductCategorySummary[];
  isLoadingCategories?: boolean;
  selectedCategory?: string;
  /** Hide availability toggle (e.g. mobile drawer shows it in the toolbar). */
  hideAvailability?: boolean;
}

export default function Filter({
  showAvailableOnly = false,
  categories: categoriesProp,
  isLoadingCategories: isLoadingCategoriesProp,
  selectedCategory,
  hideAvailability = false,
}: FilterProps) {
  const [query, setQuery] = useQueryStates(plpQueryParsers, plpQueryOptions);
  const { available, minPrice, maxPrice, sort, size, color } = query;
  const selectedSizes = size ?? [];
  const selectedColors = color ?? [];
  const router = useRouter();
  const searchParams = useSearchParams();
  const [localCategories, setLocalCategories] = useState<ProductCategorySummary[]>([]);
  const [isFetchingCategories, setIsFetchingCategories] = useState(!categoriesProp);
  const [sizeTitles, setSizeTitles] = useState<string[]>([]);
  const [isLoadingSizes, setIsLoadingSizes] = useState(true);
  const [catalogColors, setCatalogColors] = useState<
    Awaited<ReturnType<typeof getProductVariationColors>>
  >([]);
  const [isLoadingColors, setIsLoadingColors] = useState(true);

  useEffect(() => {
    if (categoriesProp) {
      return;
    }

    let isMounted = true;

    const fetchCategories = async () => {
      try {
        setIsFetchingCategories(true);
        const categories = await getProductCategories({ sort: "Title:asc" });
        if (!isMounted) return;
        setLocalCategories(categories);
      } catch (error) {
        console.error("Error fetching categories:", error);
        if (!isMounted) return;
        setLocalCategories([]);
      } finally {
        if (!isMounted) return;
        setIsFetchingCategories(false);
      }
    };

    fetchCategories();
    return () => {
      isMounted = false;
    };
  }, [categoriesProp]);

  useEffect(() => {
    let isMounted = true;
    const loadAttributes = async () => {
      try {
        const [sizes, colors] = await Promise.all([
          getProductVariationSizes(),
          getProductVariationColors(),
        ]);
        if (!isMounted) return;
        setSizeTitles(sizes.map((item) => item.title));
        setCatalogColors(colors);
      } catch (error) {
        console.error("Error fetching PLP variation filters:", error);
        if (!isMounted) return;
        setSizeTitles([]);
        setCatalogColors([]);
      } finally {
        if (!isMounted) return;
        setIsLoadingSizes(false);
        setIsLoadingColors(false);
      }
    };
    void loadAttributes();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (showAvailableOnly && available !== "true") {
      void setQuery({ available: "true" });
    }
  }, [showAvailableOnly, available, setQuery]);

  const handleCategorySelect = useCallback(
    (id: string) => {
      router.push(getCategoryPlpHrefWithQuery(id, searchParams));
    },
    [router, searchParams],
  );

  const handleAvailabilityChange = useCallback(
    (checked: boolean) => {
      void setQuery({ available: checked ? "true" : null, page: 1 });
    },
    [setQuery],
  );

  const handlePriceChange = useCallback(
    (min: number, max: number) => {
      void setQuery({
        page: 1,
        minPrice: min.toString(),
        maxPrice: max.toString(),
      });
    },
    [setQuery],
  );

  const handleSortToggle = useCallback(
    (value: string) => {
      void setQuery({
        page: 1,
        sort: sort === value ? null : value,
      });
    },
    [setQuery, sort],
  );

  const handleSortClear = useCallback(() => {
    void setQuery({ page: 1, sort: null });
  }, [setQuery]);

  const handleSizeToggle = useCallback(
    (key: string) => {
      void setQuery({ page: 1, size: toggleFilterValue(size, key) });
    },
    [setQuery, size],
  );

  const handleColorToggle = useCallback(
    (key: string) => {
      void setQuery({ page: 1, color: toggleFilterValue(color, key) });
    },
    [setQuery, color],
  );

  const hasActiveFilters =
    available === "true" ||
    !!minPrice ||
    !!maxPrice ||
    !!sort ||
    selectedSizes.length > 0 ||
    selectedColors.length > 0;

  const handleClearAllFilters = useCallback(() => {
    void setQuery({
      page: 1,
      available: null,
      minPrice: null,
      maxPrice: null,
      sort: null,
      size: null,
      color: null,
    });
  }, [setQuery]);

  const resolvedCategories = categoriesProp ?? localCategories;
  const resolvedIsLoading = categoriesProp
    ? (isLoadingCategoriesProp ?? false)
    : isFetchingCategories;
  // The catalogue endpoints have no category parameter -- the colour and size content
  // types hold no relation back to a variation -- so the two fetches above stay global and
  // the category scoping happens here. Keeping `selectedCategory` in these dependencies is
  // also what fixes the stale list: the fetch effect runs once with `[]` deps, so nothing
  // recomputed when the shopper moved between categories.
  const categoryFilterRule = useMemo(
    () => resolveCategoryFilterRule(selectedCategory, resolvedCategories),
    [selectedCategory, resolvedCategories],
  );
  const sizeBuckets = useMemo(
    () => applyCategoryFilterRuleToSizes(buildSizeBuckets(sizeTitles), categoryFilterRule),
    [sizeTitles, categoryFilterRule],
  );
  const colorBuckets = useMemo(
    () =>
      applyCategoryFilterRuleToColors(
        buildColorFamilyBuckets(catalogColors),
        categoryFilterRule,
      ),
    [catalogColors, categoryFilterRule],
  );
  // An empty box is worse than no box: a category with no sized variations at all (shawls,
  // socks, glasses) should not show a "سایز" heading over nothing, and should not flash
  // one while the catalogue loads either.
  const sizeFilterApplies =
    categoryFilterRule.clothing ||
    categoryFilterRule.numericRanges === null ||
    categoryFilterRule.numericRanges.length > 0;
  const showSizeFilter = sizeFilterApplies && (isLoadingSizes || sizeBuckets.length > 0);
  const showColorFilter =
    categoryFilterRule.colors !== false && (isLoadingColors || colorBuckets.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {hasActiveFilters && (
        <button
          type="button"
          onClick={handleClearAllFilters}
          data-testid="plp-clear-filters"
          className="self-start rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-infinity-primary transition hover:bg-infinity-primary-lighter/20"
        >
          حذف همه فیلترها
        </button>
      )}
      <PLPListFilterCategory
        value={selectedCategory || ""}
        title="دسته بندی محصولات"
        categories={resolvedCategories}
        onOptionSelect={(optionId: string | number) => handleCategorySelect(optionId.toString())}
        isLoading={resolvedIsLoading}
      />

      {!hideAvailability && (
        <AvailabilityFilter
          onChange={handleAvailabilityChange}
          defaultChecked={available === "true"}
        />
      )}

      {showSizeFilter && (
        <div data-testid="plp-size-filter">
          <PLPFilterBox title="سایز" defaultOpen>
            <SizeFilter
              buckets={sizeBuckets}
              selectedKeys={selectedSizes}
              isLoading={isLoadingSizes}
              onToggle={handleSizeToggle}
            />
          </PLPFilterBox>
        </div>
      )}

      {showColorFilter && (
        <div data-testid="plp-color-filter">
          <PLPFilterBox title="رنگ" defaultOpen>
            <ColorFilter
              buckets={colorBuckets}
              selectedKeys={selectedColors}
              isLoading={isLoadingColors}
              onToggle={handleColorToggle}
            />
          </PLPFilterBox>
        </div>
      )}

      <PLPFilterBox title="قیمت">
        <PriceFilter
          minPriceValue={minPrice ? parseInt(minPrice) : undefined}
          maxPriceValue={maxPrice ? parseInt(maxPrice) : undefined}
          minPrice={50000}
          maxPrice={10000000}
          onPriceChange={handlePriceChange}
        />
      </PLPFilterBox>

      <PLPFilterBox title="مرتب سازی" defaultOpen>
        <div className="flex flex-col gap-2">
          {SORT_OPTIONS.map((option) => {
            const isActive = sort === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={isActive}
                onClick={() => handleSortToggle(option.value)}
                className={`flex w-full items-center justify-between rounded-xl border px-4 py-2 text-sm font-semibold transition ${isActive ? "border-infinity-primary bg-infinity-primary-lighter/20 text-infinity-primary-dark" : "border-slate-200 bg-white text-neutral-700 hover:border-infinity-primary-lighter/60"}`}
              >
                <span>{option.label}</span>
                <span
                  className={`h-4 w-4 rounded-full border transition ${isActive ? "border-infinity-primary bg-infinity-primary" : "border-slate-300 bg-transparent"}`}
                />
              </button>
            );
          })}
          {sort && (
            <button
              type="button"
              onClick={handleSortClear}
              className="text-right text-xs text-infinity-primary underline-offset-2 hover:text-infinity-primary-dark"
            >
              حذف مرتب‌سازی
            </button>
          )}
        </div>
      </PLPFilterBox>
    </div>
  );
}
