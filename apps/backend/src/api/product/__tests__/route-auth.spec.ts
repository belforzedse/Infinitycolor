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

  it("requires the variation-management capability to replace a product's colour", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.path === "/products/:id/variation-colors/replace",
    );

    expect(route).toBeDefined();
    expect(route?.method).toBe("POST");
    expect(route?.handler).toBe("product.replaceVariationColor");
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

  it.each([
    ["/products/:id/soft-delete", "product.softDelete", "product.softDelete"],
    ["/products/:id/restore", "product.restore", "product.restore"],
    ["/products/:id/permanent-delete", "product.permanentDelete", "product.delete"],
    ["/products/trash/empty", "product.emptyTrash", "product.delete"],
  ])("gates %s on its own lifecycle capability", (path, handler, capability) => {
    const route = routeConfig.routes.find((entry) => entry.path === path);

    expect(route).toBeDefined();
    expect(route?.method).toBe("POST");
    expect(route?.handler).toBe(handler);
    expect(route?.config.auth).toEqual({ scope: [] });
    expect(route?.config.policies).toEqual([
      { name: "global::require-capability", config: { capability } },
    ]);
  });

  it("leaves the per-action capability of the bulk lifecycle route to the controller", () => {
    const route = routeConfig.routes.find((entry) => entry.path === "/products/lifecycle/bulk");

    expect(route).toBeDefined();
    expect(route?.method).toBe("POST");
    expect(route?.handler).toBe("product.bulkLifecycle");
    expect(route?.config.auth).toEqual({ scope: [] });
    expect(route?.config.policies).toEqual([]);
  });
});
