import routeConfig from "../routes/custom-router";

describe("product-category destructive route", () => {
  it("uses the shared content API auth strategy and category-delete capability", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.path === "/product-categories/:id/delete-with-reassign",
    );

    expect(route).toBeDefined();
    expect(route?.config.auth).toEqual({ scope: [] });
    expect(route?.config.middlewares).toEqual([{ name: "global::catalog-edit", config: { resource: "category-associations" } }]);
    expect(route?.config.policies).toEqual([
      {
        name: "global::require-capability",
        config: { capability: "category.delete" },
      },
    ]);
  });
});
