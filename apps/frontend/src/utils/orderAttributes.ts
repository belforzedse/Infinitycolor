import { unwrapCollection, unwrapEntity } from "@/utils/strapi";

/** One attribute of a purchased variation: the attribute's own name and the chosen term. */
export type VariantAttribute = {
  /** The catalog attribute, e.g. «کد». Absent when the relation was not populated. */
  name?: string;
  /** The chosen term, e.g. «۱». */
  value: string;
};

const titleKey = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export const isColorAttribute = (attribute: any) =>
  attribute?.Type === "Color" || attribute?.LegacyProjection === "Color";
export const isSizeAttribute = (attribute: any) => attribute?.LegacyProjection === "Size";
export const isModelAttribute = (attribute: any) => attribute?.LegacyProjection === "Model";

/** A variation's attribute terms, unwrapped, in catalog order. */
export const variationAttributeTerms = (variation: any): Record<string, any>[] =>
  unwrapCollection(variation?.selected_attribute_terms)
    .map((term: unknown) => unwrapEntity(term))
    .filter(Boolean) as Record<string, any>[];

/**
 * The term whose attribute projects onto a legacy dimension. Colour, size and
 * model can live purely as catalog terms (LegacyProjection "None" plus a Color
 * type, e.g. a WooCommerce colour taxonomy), so an empty `product_variation_*`
 * relation does not mean the dimension is missing.
 */
export const findAttributeTerm = (
  terms: Record<string, any>[],
  matches: (attribute: any) => boolean,
) => terms.find((term) => matches(unwrapEntity(term?.product_attribute)));

/**
 * The attributes a variation carries that have no legacy relation column of their
 * own — a «کد» design code and the like. They are ordinary attributes; the catalog
 * just stores them as terms, so they belong next to colour/size/model rather than
 * only when all three are missing. Two variations of one product often differ by
 * exactly this attribute, and leaving it out prints them as the same line.
 *
 * A term is assigned to a dimension by its attribute's projection, not by "did we
 * already read this one", so a Size-projected term never repeats beside the size it
 * fed. `shown` additionally drops a term that merely spells out a dimension already
 * displayed — rows whose `product_attribute` was never populated carry no
 * projection to judge them by.
 */
export const customVariantAttributes = (
  terms: Record<string, any>[],
  shown: Array<string | undefined>,
): VariantAttribute[] => {
  const seen = new Set(shown.map(titleKey).filter(Boolean));
  const attributes: VariantAttribute[] = [];
  for (const term of terms) {
    const attribute = unwrapEntity(term?.product_attribute);
    if (isColorAttribute(attribute) || isSizeAttribute(attribute) || isModelAttribute(attribute)) {
      continue;
    }
    const value = String(term?.Title ?? "").trim();
    const key = titleKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const name = String(attribute?.Title ?? "").trim();
    attributes.push(name ? { name, value } : { value });
  }
  return attributes;
};

/**
 * Names the attribute alongside its term — «کد» + «۱» reads «کد ۱». Terms imported
 * from WooCommerce usually already spell the attribute out, so «کد ۴» is left as
 * it is instead of becoming «کد کد ۴».
 */
export const formatVariantAttribute = (
  { name, value }: VariantAttribute,
  separator = " ",
): string => {
  const label = String(name ?? "").trim();
  if (!label || titleKey(value).includes(titleKey(label))) return value;
  return `${label}${separator}${value}`;
};

export const formatVariantAttributes = (attributes: VariantAttribute[], separator = " ") =>
  attributes.map((attribute) => formatVariantAttribute(attribute, separator));
