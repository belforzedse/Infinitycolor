export const OPERATIONAL_CATEGORY_FIELDS = [
  "Title",
  "Slug",
  "Image",
  "MegaMenuImage",
  "Color",
  "isMainCategory",
  "featured",
  "parent",
] as const;

/**
 * Older admin clients posted PascalCase `Parent`. The schema field is `parent`,
 * and operational roles reject unknown keys, so copy then drop the legacy key
 * before the write whitelist runs.
 */
export function remapLegacyCategoryParentField(
  data: Record<string, unknown> | null | undefined,
): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(data, "Parent")) {
    return;
  }
  if (data.parent === undefined) {
    data.parent = data.Parent;
  }
  delete data.Parent;
}
