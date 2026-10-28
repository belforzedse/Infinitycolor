import type { ProductDetail } from "@/services/product/product";

/**
 * Normalizes a relation to always be `{ data: ... }`-wrapped, tolerating both
 * the flat entityService shape and the already-wrapped v4 REST shape — the
 * backend has historically returned either depending on the route.
 */
const normalizeColorGalleries = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  return value
    .filter((gallery) => gallery && typeof gallery === "object" && !Array.isArray(gallery))
    .map((gallery) => ({
      ...gallery,
      color: normalizeRelation(gallery.color) ?? { data: null },
      Images: normalizeRelation(gallery.Images) ?? { data: [] },
    }));
};

export const normalizeRelation = (rel: any, isVariation = false): any => {
  if (!rel) return null;

  if (rel.data) return rel;

  if (Array.isArray(rel)) {
    return {
      data: rel.map((item: any) => {
        if (item.attributes) {
          if (isVariation) {
            const {
              product_stock,
              product_variation_color,
              product_variation_size,
              product_variation_model,
              ...rest
            } = item.attributes;

            return {
              ...item,
              attributes: {
                ...rest,
                product_stock: normalizeRelation(product_stock),
                product_variation_color: normalizeRelation(product_variation_color),
                product_variation_size: normalizeRelation(product_variation_size),
                product_variation_model: normalizeRelation(product_variation_model),
              },
            };
          }

          return item;
        }

        const {
          id,
          product_stock,
          product_variation_color,
          product_variation_size,
          product_variation_model,
          ...rest
        } = item;
        const normalized: any = { id, attributes: rest };

        if (isVariation) {
          normalized.attributes.product_stock = normalizeRelation(product_stock);
          normalized.attributes.product_variation_color =
            normalizeRelation(product_variation_color);
          normalized.attributes.product_variation_size = normalizeRelation(product_variation_size);
          normalized.attributes.product_variation_model =
            normalizeRelation(product_variation_model);
        }

        return normalized;
      }),
    };
  }

  if (rel.id !== undefined) {
    const { id, ...rest } = rel;
    return {
      data: { id, attributes: rest },
    };
  }

  return null;
};

export const normalizeProductDetail = (rawProduct: any): ProductDetail | null => {
  if (!rawProduct) return null;

  if (rawProduct.attributes) {
    return {
      ...rawProduct,
      attributes: {
        ...rawProduct.attributes,
        product_main_category: normalizeRelation(rawProduct.attributes.product_main_category),
        product_other_categories: normalizeRelation(rawProduct.attributes.product_other_categories),
        product_variations: normalizeRelation(rawProduct.attributes.product_variations, true),
        product_reviews: normalizeRelation(rawProduct.attributes.product_reviews),
        product_tags: normalizeRelation(rawProduct.attributes.product_tags),
        CoverImage: normalizeRelation(rawProduct.attributes.CoverImage),
        Media: normalizeRelation(rawProduct.attributes.Media),
        ColorGalleries: normalizeColorGalleries(rawProduct.attributes.ColorGalleries),
        Files: normalizeRelation(rawProduct.attributes.Files),
        product_size_helper: normalizeRelation(rawProduct.attributes.product_size_helper),
      },
    };
  }

  const {
    id,
    product_main_category,
    product_other_categories,
    product_variations,
    product_reviews,
    product_tags,
    CoverImage,
    Media,
    Files,
    product_size_helper,
    ...rest
  } = rawProduct;

  return {
    id,
    attributes: {
      ...rest,
      product_main_category: normalizeRelation(product_main_category),
      product_other_categories: normalizeRelation(product_other_categories),
      product_variations: normalizeRelation(product_variations, true),
      product_reviews: normalizeRelation(product_reviews),
      product_tags: normalizeRelation(product_tags),
      CoverImage: normalizeRelation(CoverImage),
      Media: normalizeRelation(Media),
      ColorGalleries: normalizeColorGalleries(rawProduct.ColorGalleries),
      Files: normalizeRelation(Files),
      product_size_helper: normalizeRelation(product_size_helper),
    },
  } as ProductDetail;
};
