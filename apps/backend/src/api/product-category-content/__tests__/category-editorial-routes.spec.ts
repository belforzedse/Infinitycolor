import routeConfig from "../routes/product-category-content";

describe("category editorial route auth", () => {
  it("scopes management routes to the token actions and capability policy", () => {
    const targets = routeConfig.routes.find((entry) => entry.path === "/category-editorial/targets");
    const editable = routeConfig.routes.find(
      (entry) => entry.method === "GET" && entry.path === "/category-editorial/:categoryId",
    );
    const upsert = routeConfig.routes.find(
      (entry) => entry.method === "PUT" && entry.path === "/category-editorial/:categoryId",
    );

    expect(targets?.config.auth).toEqual({ scope: [] });
    expect(editable?.config.auth).toEqual({ scope: [] });
    expect(upsert?.config.auth).toEqual({ scope: [] });
    for (const route of [targets, editable, upsert]) {
      expect(route?.config.policies).toEqual([
        {
          name: "global::require-capability",
          config: { capability: "content.categoryEditorial.manage" },
        },
      ]);
    }
  });
});
