import { registerCatalogInteractiveAssertions, validateCatalogAttributeReferences } from "../catalogOwnership";

describe("native catalog lifecycle guards", () => {
  let subscription: any;
  beforeEach(() => registerCatalogInteractiveAssertions({
    requestContext: { get: () => ({ state: { user: { id: 5 } } }) },
    db: { lifecycles: { subscribe: (value: any) => { subscription = value; } } },
  }));

  it.each(["api::product.product", "api::product-attribute.product-attribute", "api::product-attribute-term.product-attribute-term", "api::product-stock.product-stock"])("rejects a native bulk predicate before owner inference for %s", async (uid) => {
    await expect(subscription.beforeDeleteMany({ action: "beforeDeleteMany", model: { uid }, params: { where: { $and: [{ id: { $in: [1, 2] } }] } } })).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
  });

  it("requires ownership for an empty-data single product deletion", async () => {
    await expect(subscription.beforeDelete({ action: "beforeDelete", model: { uid: "api::product.product" }, params: { where: { id: 1 } } })).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
  });

  it("rejects linking another product's private attribute or term", async () => {
    const strapi = { db: { query: (uid: string) => ({ findOne: async () => uid.includes("-term.") ? { product_attribute: { owner_product: { id: 2 } } } : { owner_product: { id: 2 } } }) } };
    await expect(validateCatalogAttributeReferences(strapi, 1, { product_attribute: 3 })).rejects.toMatchObject({ code: "CATALOG_PARENT_CHANGE_FORBIDDEN" });
    await expect(validateCatalogAttributeReferences(strapi, 1, { selected_attribute_terms: [4] })).rejects.toMatchObject({ code: "CATALOG_PARENT_CHANGE_FORBIDDEN" });
    await expect(validateCatalogAttributeReferences(strapi, 2, { terms: [4] })).resolves.toBeUndefined();
  });
});
