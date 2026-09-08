import type { categoryResponseType } from "@/services/super-admin/product/category/getAll";

/**
 * Where a category sits, for pickers that would otherwise show only a leaf name.
 *
 * The product-category dialog used to disambiguate options with the raw slug,
 * which is a routing detail staff do not think in. A parent path answers the
 * question the slug was standing in for — "which کفش is this?" — in the
 * operator's own vocabulary.
 */
export function categoryPathLabel(
  category: categoryResponseType,
): string | null {
  const parentTitle =
    category.attributes?.parent?.data?.attributes?.Title?.trim();
  return parentTitle
    ? `${parentTitle} › ${category.attributes?.Title ?? ""}`.trim()
    : null;
}

/** Matches a category on its own name, its parent's name, or its slug. */
export function categoryMatchesQuery(
  category: categoryResponseType,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const title = (category.attributes?.Title || "").toLowerCase();
  const slug = (category.attributes?.Slug || "").toLowerCase();
  const parent = (
    category.attributes?.parent?.data?.attributes?.Title || ""
  ).toLowerCase();
  return title.includes(q) || slug.includes(q) || parent.includes(q);
}
