import { HEADER_EXTRA_CATEGORIES } from "@/constants/categories";
import type { ProductCategorySummary } from "@/services/product/categories";

type HeaderExtraCategory = (typeof HEADER_EXTRA_CATEGORIES)[number];

function applyExtraMegaMenuImage(
  category: ProductCategorySummary,
  extra: HeaderExtraCategory,
): ProductCategorySummary {
  if (category.megaMenuImageUrl) return category;

  return {
    ...category,
    megaMenuImageUrl: extra.megaMenuImageUrl,
    megaMenuImageAlt: extra.megaMenuImageAlt,
    megaMenuImageWidth: extra.megaMenuImageWidth,
    megaMenuImageHeight: extra.megaMenuImageHeight,
  };
}

function toHeaderCategory(extra: HeaderExtraCategory): ProductCategorySummary {
  return applyExtraMegaMenuImage(
    {
      id: extra.id,
      name: extra.name,
      slug: extra.slug,
      imageUrl: null,
      imageAlt: extra.name,
      megaMenuImageUrl: null,
      megaMenuImageAlt: extra.name,
      parentId: null,
      isMainCategory: true,
      featured: false,
      hasChildren: false,
      children: [],
    },
    extra,
  );
}

/**
 * Appends hardcoded top-level header categories when they are missing from the
 * Navigation assignment, so desktop nav and mobile groups treat them like CMS items.
 * Also fills a static megamenu image when the CMS category has none.
 */
export function withHeaderExtraCategories(
  categories: ProductCategorySummary[],
): ProductCategorySummary[] {
  const extrasBySlug = new Map<string, HeaderExtraCategory>(
    HEADER_EXTRA_CATEGORIES.map((extra) => [extra.slug, extra]),
  );
  const merged = categories.map((category) => {
    const extra = extrasBySlug.get(category.slug);
    return extra ? applyExtraMegaMenuImage(category, extra) : category;
  });
  const extras = HEADER_EXTRA_CATEGORIES.filter(
    (extra) => !categories.some((category) => category.slug === extra.slug),
  ).map(toHeaderCategory);

  return extras.length === 0 ? merged : [...merged, ...extras];
}
