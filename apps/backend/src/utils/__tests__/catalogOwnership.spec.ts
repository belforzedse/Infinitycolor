import { registerCatalogInteractiveAssertions, validateCatalogAttributeReferences } from "../catalogOwnership";

describe("native catalog lifecycle guards", () => {
  let subscription: any;
  beforeEach(() => registerCatalogInteractiveAssertions({
    entityService: { decorate: jest.fn() },
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

describe("gallery entity-service guard", () => {
  let update: jest.Mock;
  let guardedUpdate: any;
  let request: any;
  beforeEach(() => {
    update = jest.fn(async () => ({ id: 1 }));
    request = { state: { user: { id: 5 } } };
    registerCatalogInteractiveAssertions({
      entityService: { decorate: (decorate: any) => { guardedUpdate = decorate({ update }).update; } },
      requestContext: { get: () => request },
      db: { lifecycles: { subscribe: jest.fn() } },
    });
  });

  it.each([{ ColorGalleries: [] }, { ColorGalleries: [{ color: 1, Images: [2] }] }, { ColorGalleries: [{ id: 7, color: 1, Images: [2] }] }])(
    "rejects unguarded gallery writes before the entity service can persist components: %j",
    async ({ ColorGalleries }) => {
      await expect(guardedUpdate("api::product.product", 1, { data: { ColorGalleries } }))
        .rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("keeps non-gallery product updates on the existing lifecycle path", async () => {
    const params = { data: { SeenCount: 1 } };
    await guardedUpdate("api::product.product", 1, params);
    expect(update).toHaveBeenCalledWith("api::product.product", 1, params);
  });

  it("preserves noninteractive system writes", async () => {
    request = undefined;
    const params = { data: { ColorGalleries: [] } };
    await guardedUpdate("api::product.product", 1, params);
    expect(update).toHaveBeenCalledWith("api::product.product", 1, params);
  });
});
