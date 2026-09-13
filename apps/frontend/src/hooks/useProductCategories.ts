import { useEffect, useState } from "react";
import {
  getCachedNavbarProductCategories,
  getProductCategories,
  type ProductCategorySummary,
} from "@/services/product/categories";

interface UseProductCategoriesOptions {
  parentOnly?: boolean;
  mainOnly?: boolean;
  /** When true, only categories marked as featured in Strapi (carousel / bottom nav sheet). */
  featuredOnly?: boolean;
  /** When true, fetch direct children for desktop megamenu links. */
  includeChildren?: boolean;
  /** When true, read categories assigned to the Navigation single type. */
  navbarAssignedOnly?: boolean;
  /** When provided, only categories whose name includes one of these substrings are returned. */
  allowedNameSubstrings?: readonly string[];
  initial?: ProductCategorySummary[];
  enabled?: boolean;
}

const categoryRequestCache = new Map<string, Promise<ProductCategorySummary[]>>();
const categoryDataCache = new Map<string, ProductCategorySummary[]>();

const getCategoryCacheKey = (options: Omit<UseProductCategoriesOptions, "initial" | "enabled">) =>
  JSON.stringify({
    parentOnly: options.parentOnly ?? false,
    mainOnly: options.mainOnly ?? false,
    featuredOnly: options.featuredOnly ?? null,
    includeChildren: options.includeChildren ?? false,
    navbarAssignedOnly: options.navbarAssignedOnly ?? false,
    allowedNameSubstrings: options.allowedNameSubstrings ?? [],
  });

export const useProductCategories = (options: UseProductCategoriesOptions = {}) => {
  const {
    parentOnly = false,
    mainOnly = false,
    featuredOnly,
    includeChildren,
    navbarAssignedOnly,
    allowedNameSubstrings,
    initial,
    enabled = true,
  } = options;
  const cacheKey = getCategoryCacheKey({
    parentOnly,
    mainOnly,
    featuredOnly,
    includeChildren,
    navbarAssignedOnly,
    allowedNameSubstrings,
  });
  const cached = categoryDataCache.get(cacheKey);
  const [categories, setCategories] = useState<ProductCategorySummary[]>(initial ?? cached ?? []);
  const [isLoading, setIsLoading] = useState(enabled && !initial && !cached);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (initial) return;
    if (!enabled) return;
    const cachedData = categoryDataCache.get(cacheKey);
    if (cachedData) {
      setCategories(cachedData);
      setIsLoading(false);
      return;
    }
    let isMounted = true;

    const fetchCategories = async () => {
      try {
        setIsLoading(true);
        setError(null);
        let request = categoryRequestCache.get(cacheKey);
        if (!request) {
          // Evict the in-flight entry once it settles. Previously a rejected promise
          // stayed in this map forever, so every later mount awaited the same failure and
          // categories could not recover without a full page reload.
          //
          // The evicting promise is the one that gets both cached and awaited: caching a
          // derived promise while awaiting the original would leave the derived rejection
          // unhandled.
          request = (
            navbarAssignedOnly
              ? getCachedNavbarProductCategories({ includeChildren })
              : getProductCategories({
                  parentOnly,
                  mainOnly,
                  featuredOnly,
                  includeChildren,
                  allowedNameSubstrings,
                })
          ).finally(() => {
            categoryRequestCache.delete(cacheKey);
          });
          categoryRequestCache.set(cacheKey, request);
        }
        const data = await request;
        // Only a successful response reaches the data cache. A legitimately empty
        // collection is real data and is cached; a failed request is not.
        categoryDataCache.set(cacheKey, data);
        if (!isMounted) return;
        setCategories(data);
      } catch (err) {
        if (!isMounted) return;
        // Keep whatever good data we already have. Replacing it with [] turned a
        // transient backend blip into an apparently empty catalog.
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!isMounted) return;
        setIsLoading(false);
      }
    };

    fetchCategories();

    return () => {
      isMounted = false;
    };
  }, [
    initial,
    enabled,
    cacheKey,
    parentOnly,
    mainOnly,
    featuredOnly,
    includeChildren,
    navbarAssignedOnly,
    allowedNameSubstrings,
  ]);

  return { categories, isLoading, error };
};

export default useProductCategories;
