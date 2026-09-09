import routeConfig from "../routes/custom-router";

describe("product operational routes", () => {
  it("protects the publication command and leaves role/importer authorization to the controller", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.path === "/products/:id/publication",
    );

    expect(route).toBeDefined();
    expect(route?.method).toBe("POST");
    expect(route?.config.auth).toEqual({ scope: [] });
    expect(route?.config.policies).toEqual([]);
  });

  it("requires the variation-management capability", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.path === "/products/:id/variation-combinations",
    );

    expect(route).toBeDefined();
    expect(route?.config.auth).toEqual({ scope: [] });
    expect(route?.config.policies).toEqual([
      {
        name: "global::require-capability",
        config: { capability: "product.variation.manage" },
      },
    ]);
  });

  it("requires the scheduling capability for product display-date changes", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.path === "/products/:id/display-date",
    );

    expect(route).toBeDefined();
    expect(route?.method).toBe("PUT");
    expect(route?.config.auth).toEqual({ scope: [] });
    expect(route?.config.policies).toEqual([
      {
        name: "global::require-capability",
        config: { capability: "product.schedule" },
      },
    ]);
  });
});
