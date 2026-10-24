import { sanitize } from "@strapi/utils";

export const EDITOR_POPULATE = {
  Files: true,
  Media: true,
  CoverImage: true,
  ColorGalleries: {
    populate: {
      color: true,
      Images: true,
    },
  },
  product_main_category: true,
  product_tags: true,
  product_other_categories: true,
  product_size_helper: true,
  product_faqs: true,
  owned_product_attributes: { populate: { product_attribute_terms: true } },
  product_attribute_assignments: { populate: { product_attribute: true, terms: true } },
  product_variations: {
    populate: {
      product_stock: true,
      product_variation_color: true,
      product_variation_size: true,
      product_variation_model: true,
      selected_attribute_terms: { populate: { product_attribute: true } },
    },
  },
};

function apiEntity(strapi: any, uid: string, entity: any): any {
  if (!entity) return null;
  const attributes: Record<string, unknown> = {};
  const schema = strapi.getModel(uid);
  for (const [key, value] of Object.entries(entity)) {
    if (key === "id") continue;
    const attribute = schema.attributes[key];
    if (attribute?.type === "relation" || attribute?.type === "media") {
      const target = attribute.type === "media" ? "plugin::upload.file" : attribute.target;
      attributes[key] = {
        data: Array.isArray(value)
          ? value.map((row) => apiEntity(strapi, target, row))
          : apiEntity(strapi, target, value),
      };
    } else if (attribute?.type === "component") {
      const formatComponent = (row: any) => {
        const formatted = apiEntity(strapi, attribute.component, row);

        if (!formatted) return null;

        return {
          id: formatted.id,
          ...formatted.attributes,
        };
      };

      attributes[key] = Array.isArray(value) ? value.map(formatComponent) : formatComponent(value);
    } else {
      attributes[key] = value;
    }
  }
  return { id: entity.id, attributes };
}

export async function loadEditorSnapshot(strapi: any, productId: number) {
  const product = await strapi.entityService.findOne("api::product.product", productId, {
    populate: EDITOR_POPULATE,
  });
  const safe = await sanitize.contentAPI.output(product, strapi.getModel("api::product.product"));
  return {
    product: apiEntity(strapi, "api::product.product", safe),
    revision: Number(product?.EditRevision || 0),
  };
}
