import {
  applyCategoryFilterRuleToSizes,
  DEFAULT_CATEGORY_FILTER_RULE,
  resolveCategoryFilterRule,
} from "../plpCategoryFilters";
import { buildSizeBuckets } from "../plpSizeFilter";
import type { ProductCategorySummary } from "@/services/product/categories";

const category = (
  id: number,
  slug: string,
  parentId: number | null = null,
): ProductCategorySummary =>
  ({
    id,
    slug,
    parentId,
    name: slug,
    imageUrl: null,
    imageAlt: "",
    megaMenuImageUrl: null,
    megaMenuImageAlt: "",
    isMainCategory: parentId === null,
  }) as ProductCategorySummary;

// A slice of the live catalogue: letters, shoe numbers, bra bands, waist numbers and the
// Iranian "سایز ۱/۲/۳" system all live in one flat list.
const CATALOG_TITLES = [
  "S",
  "M",
  "L",
  "XL",
  "2xl",
  "36",
  "38",
  "40",
  "42",
  "44",
  "30",
  "32",
  "34",
  "70",
  "80",
  "90",
  "سایز 1",
  "سایز 2",
];

const keysFor = (slug: string, categories: ProductCategorySummary[]) =>
  applyCategoryFilterRuleToSizes(
    buildSizeBuckets(CATALOG_TITLES),
    resolveCategoryFilterRule(slug, categories),
  ).map((bucket) => bucket.key);

describe("plpCategoryFilters", () => {
  const categories = [
    category(1, "shoes"),
    category(2, "socks"),
    category(3, "mens-socks", 2),
    category(4, "under-wear"),
    category(5, "pants"),
    category(6, "jeans", 5),
    category(7, "brand-new-category"),
  ];

  it("keeps only shoe numbers on a shoes page", () => {
    const keys = keysFor("shoes", categories);
    expect(keys).toEqual(expect.arrayContaining(["36", "38", "40", "42", "44"]));
    expect(keys).not.toEqual(expect.arrayContaining(["s", "m", "l", "xl", "2xl"]));
    // Bra bands and the Iranian size numbers are not shoe sizes.
    expect(keys).not.toEqual(expect.arrayContaining(["70", "80", "90", "1", "2"]));
  });

  it("hides every size chip for an accessory category and for its children", () => {
    expect(keysFor("socks", categories)).toEqual([]);
    expect(keysFor("mens-socks", categories)).toEqual([]);
  });

  it("keeps bra bands on underwear but not waist or shoe numbers", () => {
    const keys = keysFor("under-wear", categories);
    expect(keys).toEqual(expect.arrayContaining(["l", "xl", "70", "80", "90"]));
    expect(keys).not.toEqual(expect.arrayContaining(["30", "32", "34", "36", "44"]));
  });

  it("lets a child inherit its root rule", () => {
    // jeans sits under pants, which uses waist numbers down to 26.
    const keys = keysFor("jeans", categories);
    expect(keys).toEqual(expect.arrayContaining(["30", "32", "34", "l", "1", "2"]));
    expect(keys).not.toEqual(expect.arrayContaining(["70", "80", "90"]));
  });

  it("falls back to the unscoped rule for an unmapped category", () => {
    expect(resolveCategoryFilterRule("brand-new-category", categories)).toBe(
      DEFAULT_CATEGORY_FILTER_RULE,
    );
    expect(resolveCategoryFilterRule(undefined, categories)).toBe(
      DEFAULT_CATEGORY_FILTER_RULE,
    );
    // A slug the category list has never heard of must not lose its filters either.
    expect(resolveCategoryFilterRule("unknown-slug", categories)).toBe(
      DEFAULT_CATEGORY_FILTER_RULE,
    );

    const keys = keysFor("brand-new-category", categories);
    expect(keys).toEqual(expect.arrayContaining(["s", "l", "36", "70", "30"]));
  });

  it("does not loop on a category cycle", () => {
    const cyclic = [category(10, "a", 11), category(11, "b", 10)];
    expect(resolveCategoryFilterRule("a", cyclic)).toBe(DEFAULT_CATEGORY_FILTER_RULE);
  });
});
