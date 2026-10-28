import {
  CatalogEditError,
  catalogMutationContext,
  homepageSettingsWriteActive,
} from "./catalogEdit";
import { resolveRawExecutor } from "./transactionExecutor";

const OWNED = {
  product_variations: "api::product-variation.product-variation",
  product_attribute_assignments: "api::product-attribute-assignment.product-attribute-assignment",
  owned_product_attributes: "api::product-attribute.product-attribute",
  product_size_helper: "api::product-size-helper.product-size-helper",
  product_faqs: "api::product-faq.product-faq",
} as const;

const INVERSE_FIELDS: Record<string, readonly string[]> = {
  "api::product-category.product-category": ["products", "product_others"],
  "api::product-attribute.product-attribute": [
    "product_attribute_terms",
    "product_attribute_assignments",
  ],
  "api::product-attribute-term.product-attribute-term": [
    "product_variations",
    "product_attribute_assignments",
  ],
};

/** Mutate relationships from the endpoint that locks their persisted owner. */
export function rejectCatalogInverseRelations(uid: string, data: any) {
  if ((INVERSE_FIELDS[uid] || []).some((field) => field in data)) {
    throw new CatalogEditError("CATALOG_INVERSE_RELATION_FORBIDDEN", 400);
  }
}

export async function validateCatalogAttributeReferences(
  strapi: any,
  productId: number,
  data: any,
) {
  for (const id of connectedIds(data.product_attribute)) {
    const attribute = await strapi.db
      .query("api::product-attribute.product-attribute")
      .findOne({ where: { id }, populate: { owner_product: true } });
    if (!attribute) throw new CatalogEditError("CATALOG_RELATION_INVALID", 400);
    if (attribute.owner_product && connectedIds(attribute.owner_product)[0] !== productId)
      throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
  }
  for (const id of [...connectedIds(data.terms), ...connectedIds(data.selected_attribute_terms)]) {
    const term = await strapi.db
      .query("api::product-attribute-term.product-attribute-term")
      .findOne({
        where: { id },
        populate: { product_attribute: { populate: { owner_product: true } } },
      });
    if (!term) throw new CatalogEditError("CATALOG_RELATION_INVALID", 400);
    const owner = term.product_attribute?.owner_product;
    if (owner && connectedIds(owner)[0] !== productId)
      throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
  }
}

function connectedIds(value: any): number[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(connectedIds);
  if (typeof value === "object") {
    if ("id" in value) return connectedIds(value.id);
    return [
      ...connectedIds(value.connect),
      ...connectedIds(value.set),
      ...connectedIds(value.data),
    ];
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new CatalogEditError("CATALOG_RELATION_INVALID", 400);
  return [id];
}

export async function validateProductOwnedRelations(
  strapi: any,
  productId: number | null,
  data: any,
) {
  for (const [field, uid] of Object.entries(OWNED)) {
    if (!(field in data)) continue;
    const ownerField = field === "owned_product_attributes" ? "owner_product" : "product";
    for (const id of connectedIds(data[field])) {
      const child = await strapi.db
        .query(uid)
        .findOne({ where: { id }, populate: { [ownerField]: true } });
      if (!child) throw new CatalogEditError("CATALOG_RELATION_INVALID", 400);
      // Orphan children cannot be claimed through a parent update either: two
      // separately leased products could otherwise race to claim the same row.
      if (!productId || Number(child[ownerField]?.id) !== productId)
        throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
    }
  }
  const categoryIds = [
    ...new Set(
      ["product_main_category", "product_other_categories"].flatMap((field) =>
        connectedIds(data[field]),
      ),
    ),
  ].sort((a, b) => a - b);
  const galleryMediaIds = Array.isArray(data.ColorGalleries)
    ? data.ColorGalleries.flatMap((gallery: any) => connectedIds(gallery?.Images))
    : [];

  const mediaIds = [
    ...new Set([
      ...["CoverImage", "Media", "Files"].flatMap((field) => connectedIds(data[field])),
      ...galleryMediaIds,
    ]),
  ].sort((a, b) => a - b);
  if (!mediaIds.length && !categoryIds.length) return;
  const executor = await resolveRawExecutor(strapi);
  if (categoryIds.length) {
    const table = strapi.db.metadata.get("api::product-category.product-category").tableName;
    for (const id of categoryIds) {
      if (!(await executor(table).where({ id }).forShare().first()))
        throw new CatalogEditError("CATALOG_RELATION_INVALID", 400);
    }
  }
  const fileTable = strapi.db.metadata.get("plugin::upload.file").tableName;
  for (const id of mediaIds) {
    const file = await executor(fileTable).where({ id }).forShare().first();
    if (!file) throw new CatalogEditError("PRODUCT_MEDIA_NOT_FOUND", 400);
  }
}

/** Content Manager and future HTTP handlers cannot evade route coordination. */
export function registerCatalogInteractiveAssertions(strapi: any) {
  // Strapi writes repeatable components before the product's DB lifecycle.
  // Reject interactive gallery updates before any component can be changed.
  strapi.entityService.decorate((service: any) => ({
    async update(uid: string, entityId: number | string, params: any) {
      if (
        uid === "api::product.product" &&
        params?.data &&
        Object.prototype.hasOwnProperty.call(params.data, "ColorGalleries") &&
        strapi.requestContext?.get?.()?.state?.user
      ) {
        const guard = catalogMutationContext();
        if (!guard) throw new CatalogEditError("EDIT_LEASE_LOST");
        if (!guard.ids.includes(Number(entityId)))
          throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
      }
      return service.update.call(this, uid, entityId, params);
    },
  }));
  const models = [
    "api::product.product",
    ...Object.values(OWNED),
    "api::product-stock.product-stock",
    "api::product-attribute-term.product-attribute-term",
    "api::product-category.product-category",
    "api::settings.settings",
  ];
  const assert = async (event: any) => {
    const request = strapi.requestContext?.get?.();
    if (!request?.state?.user) return;
    // Native Content Manager bulk predicates do not expose a single owner id.
    // Refuse them before the shared-taxonomy early returns below.
    if (event.action.endsWith("Many")) throw new CatalogEditError("EDIT_LEASE_LOST", 409);
    const uid = event.model.uid;
    const data = event.params.data || {};
    rejectCatalogInverseRelations(uid, data);
    if (uid === "api::settings.settings") {
      const managed = [
        "homeNewestProductIds",
        "homeFavoriteProductIds",
        "homeDiscountedProductIds",
        "homeWeeklyPicksProductIds",
        "homeEveryoneFollowsProductIds",
        "homeWeeklyPicksEnabled",
        "homeEveryoneFollowsEnabled",
        "HomepageProductsRevision",
      ];
      if (
        (event.action.startsWith("beforeDelete") || managed.some((field) => field in data)) &&
        !homepageSettingsWriteActive()
      )
        throw new CatalogEditError("HOMEPAGE_EDITOR_REQUIRED", 409);
      return;
    }
    if (
      uid === "api::product-category.product-category" &&
      !event.action.startsWith("beforeDelete")
    )
      return;
    if (
      uid === "api::product-category.product-category" &&
      request.state.catalogEmptyCategoryDelete === true
    )
      return;
    if (
      uid === "api::product-attribute.product-attribute" ||
      uid === "api::product-attribute-term.product-attribute-term"
    ) {
      const row = event.params.where?.id
        ? await strapi.db
            .query(uid)
            .findOne({
              where: { id: event.params.where.id },
              populate:
                uid === "api::product-attribute.product-attribute"
                  ? { owner_product: true }
                  : { product_attribute: { populate: { owner_product: true } } },
            })
        : data;
      let owner =
        uid === "api::product-attribute.product-attribute"
          ? row?.owner_product
          : row?.product_attribute?.owner_product;
      if (uid === "api::product-attribute-term.product-attribute-term" && !event.params.where?.id) {
        const attribute = await strapi.db
          .query("api::product-attribute.product-attribute")
          .findOne({
            where: { id: connectedIds(data.product_attribute)[0] },
            populate: { owner_product: true },
          });
        owner = attribute?.owner_product;
      }
      if (!owner) return;
    }
    if (uid === "api::product.product") {
      if (
        event.action === "beforeUpdate" &&
        Object.keys(data).every((key) =>
          [
            "SeenCount",
            "AverageRating",
            "RatingCount",
            "updatedAt",
            "updated_at",
            "updatedBy",
          ].includes(key),
        )
      )
        return;
      await validateProductOwnedRelations(
        strapi,
        event.params.where?.id ? Number(event.params.where.id) : null,
        data,
      );
      if (event.action === "beforeCreate") return;
    }
    const guard = catalogMutationContext();
    if (!guard) throw new CatalogEditError("EDIT_LEASE_LOST");
    if (uid === "api::product-category.product-category") return;
    let productId: number;
    if (uid === "api::product.product") productId = Number(event.params.where?.id);
    else {
      const populate =
        uid === "api::product-stock.product-stock"
          ? { product_variation: { populate: { product: true } } }
          : uid === "api::product-attribute-term.product-attribute-term"
            ? { product_attribute: { populate: { owner_product: true } } }
            : uid === "api::product-attribute.product-attribute"
              ? { owner_product: true }
              : { product: true };
      const row =
        event.action === "beforeCreate"
          ? data
          : await strapi.db.query(uid).findOne({ where: event.params.where, populate });
      let owner: any;
      if (uid === "api::product-stock.product-stock") {
        const variation =
          event.action === "beforeCreate"
            ? await strapi.db
                .query("api::product-variation.product-variation")
                .findOne({
                  where: { id: connectedIds(data.product_variation)[0] },
                  populate: { product: true },
                })
            : row?.product_variation;
        owner = variation?.product;
      } else if (uid === "api::product-attribute-term.product-attribute-term") {
        const attribute =
          event.action === "beforeCreate"
            ? await strapi.db
                .query("api::product-attribute.product-attribute")
                .findOne({
                  where: { id: connectedIds(data.product_attribute)[0] },
                  populate: { owner_product: true },
                })
            : row?.product_attribute;
        owner = attribute?.owner_product;
      } else
        owner =
          uid === "api::product-attribute.product-attribute" ? row?.owner_product : row?.product;
      productId = connectedIds(owner)[0];
    }
    if (!guard.ids.includes(productId))
      throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
    if (
      uid === "api::product-variation.product-variation" ||
      uid === "api::product-attribute-assignment.product-attribute-assignment"
    )
      await validateCatalogAttributeReferences(strapi, productId, data);
  };
  strapi.db.lifecycles.subscribe({
    models,
    beforeCreate: assert,
    beforeUpdate: assert,
    beforeDelete: assert,
    beforeCreateMany: assert,
    beforeUpdateMany: assert,
    beforeDeleteMany: assert,
  });
}
