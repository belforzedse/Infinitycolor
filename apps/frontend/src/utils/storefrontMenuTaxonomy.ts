export {
  SYNTHETIC_MOBILE_CATEGORY_ID_MAX as SYNTHETIC_STOREFRONT_MENU_CATEGORY_ID_MAX,
  buildMobileMenuTaxonomy as buildStorefrontMenuTaxonomy,
  isSyntheticMobileMenuCategory as isSyntheticStorefrontMenuCategory,
} from "@/utils/mobileMenuTaxonomy";

export type {
  MobileMenuTaxonomyCategory as StorefrontMenuTaxonomyCategory,
  MobileMenuTaxonomyGroup as StorefrontMenuTaxonomyGroup,
  MobileMenuTaxonomyItem as StorefrontMenuTaxonomyItem,
} from "@/utils/mobileMenuTaxonomy";

export function getViewAllCategoryLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "مشاهده همه";
  const normalized = trimmed.replace(/\u200c/g, " ");
  const isPlural = /(^|\s)ها$/.test(normalized) || /های$/.test(normalized);
  return `مشاهده همه ${trimmed}${isPlural ? "" : "‌ها"}`;
}
