import type { CategoryFilterOption } from "@/services/product/categories";
import type { ColorFamilyBucket } from "@/utils/plpColorFilter";
import type { SizeBucket } from "@/utils/plpSizeFilter";

/**
 * Which filter chips a category is allowed to show.
 *
 * The catalogue keeps one flat list of sizes and colours, so every PLP used to offer all
 * 93 size titles at once: shoe numbers and bra bands on a socks page, clothing letters on
 * a shoes page. There is no data model that says which sizes belong to a category -- the
 * colour and size content types have no relation back to a variation -- so the mapping is
 * editorial, exactly like the size and colour vocabularies in `plpSizeFilter.ts` and
 * `plpColorFilter.ts` that it filters.
 *
 * The ranges below were derived from the live catalogue rather than guessed.
 */
export interface CategoryFilterRule {
  /** Show the S / M / L / XL family of chips. */
  clothing: boolean;
  /**
   * Inclusive numeric size ranges this category actually uses. `null` means "do not
   * scope" and shows every numeric chip -- what an unmapped category falls back to, so a
   * new category degrades to the old behaviour instead of losing its filters.
   */
  numericRanges: readonly (readonly [number, number])[] | null;
  /** Show the colour family chips. Defaults to true. */
  colors?: boolean;
}

/** Iranian "سایز ۱/۲/۳" sizing, which `sizeKeysFromTitle` reduces to small integers. */
const IRANIAN_SIZE_NUMBERS = [0, 18] as const;
/** Ready-to-wear body sizes. */
const GARMENT_NUMBERS = [36, 46] as const;

export const DEFAULT_CATEGORY_FILTER_RULE: CategoryFilterRule = {
  clothing: true,
  numericRanges: null,
};

/** Accessory groups with no sized variation in the catalogue at all. */
const ACCESSORY_RULE: CategoryFilterRule = { clothing: false, numericRanges: [] };
/** Garments sold only by letter size. */
const LETTERS_ONLY_RULE: CategoryFilterRule = {
  clothing: true,
  numericRanges: [IRANIAN_SIZE_NUMBERS],
};
/** Garments sold by letter size and by body number. */
const GARMENT_RULE: CategoryFilterRule = {
  clothing: true,
  numericRanges: [IRANIAN_SIZE_NUMBERS, GARMENT_NUMBERS],
};

/**
 * Keyed by category slug and resolved through the ancestor chain, so a child inherits its
 * root's rule and only needs an entry of its own when it genuinely differs.
 */
export const CATEGORY_FILTER_RULES: Readonly<Record<string, CategoryFilterRule>> = {
  // Shoes are the one group with no letter sizes: the catalogue holds 36-41 and 37/5.
  shoes: { clothing: false, numericRanges: [[35, 47]] },
  // Bra bands run 60-110 alongside the letter sizes.
  "under-wear": { clothing: true, numericRanges: [IRANIAN_SIZE_NUMBERS, [60, 115]] },
  // Waist sizing goes down to 26, lower than ready-to-wear body sizes.
  pants: { clothing: true, numericRanges: [IRANIAN_SIZE_NUMBERS, [26, 54]] },
  skirt: { clothing: true, numericRanges: [IRANIAN_SIZE_NUMBERS, [30, 46]] },

  "paperback-and-tonic": GARMENT_RULE,
  "house-dress": GARMENT_RULE,
  "coat-and-mantle": GARMENT_RULE,
  shirt: GARMENT_RULE,
  "jacket-and-puffer": GARMENT_RULE,
  baroni: GARMENT_RULE,
  ژیله: GARMENT_RULE,
  sweatshirt: GARMENT_RULE,
  shacket: GARMENT_RULE,
  teranchcoat: GARMENT_RULE,
  "womens-belt": GARMENT_RULE,

  coat: LETTERS_ONLY_RULE,
  "پلیور-و-بافت": LETTERS_ONLY_RULE,
  "لباس-مردانه": LETTERS_ONLY_RULE,
  "hoodie-and-dores": LETTERS_ONLY_RULE,
  winter: LETTERS_ONLY_RULE,

  "shawls-and-scarves": ACCESSORY_RULE,
  socks: ACCESSORY_RULE,
  glasses: ACCESSORY_RULE,
  کیف: ACCESSORY_RULE,

  // Editorial landing categories deliberately span the whole catalogue, so they keep the
  // unscoped rule rather than an entry that would have to track every other category.
};

/**
 * Walk from the category up through its ancestors and return the first rule found, so a
 * child category inherits its root without needing its own entry. Falls back to the
 * unscoped default for anything unmapped.
 */
export function resolveCategoryFilterRule(
  slug: string | undefined,
  categories: readonly CategoryFilterOption[],
): CategoryFilterRule {
  if (!slug) return DEFAULT_CATEGORY_FILTER_RULE;

  const bySlug = new Map(categories.map((category) => [category.slug, category]));
  const byId = new Map(categories.map((category) => [category.id, category]));

  let current = bySlug.get(slug);
  const seen = new Set<number>();
  while (current && !seen.has(current.id)) {
    const rule = CATEGORY_FILTER_RULES[current.slug];
    if (rule) return rule;
    seen.add(current.id);
    current = current.parentId != null ? byId.get(current.parentId) : undefined;
  }

  // A slug with no rule anywhere up the chain -- including one the category list does not
  // know -- keeps every chip rather than silently losing its filters.
  return DEFAULT_CATEGORY_FILTER_RULE;
}

const inAnyRange = (value: number, ranges: readonly (readonly [number, number])[]): boolean =>
  ranges.some(([min, max]) => value >= min && value <= max);

export function applyCategoryFilterRuleToSizes(
  buckets: readonly SizeBucket[],
  rule: CategoryFilterRule,
): SizeBucket[] {
  return buckets.filter((bucket) => {
    if (bucket.kind === "clothing") return rule.clothing;
    if (bucket.kind === "numeric") {
      if (rule.numericRanges === null) return true;
      const value = Number(bucket.key);
      return Number.isFinite(value) && inAnyRange(value, rule.numericRanges);
    }
    // Unparsed titles are catalogue noise. They are worth showing only where nothing is
    // scoped at all, which is the unmapped fallback.
    return rule.numericRanges === null && rule.clothing;
  });
}

export function applyCategoryFilterRuleToColors(
  buckets: readonly ColorFamilyBucket[],
  rule: CategoryFilterRule,
): ColorFamilyBucket[] {
  return rule.colors === false ? [] : [...buckets];
}
