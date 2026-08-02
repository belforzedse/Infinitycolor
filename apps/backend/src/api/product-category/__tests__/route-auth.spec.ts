import routeConfig from "../routes/custom-router";

describe("product-category destructive route", () => {
  it("uses the shared content API auth strategy and Superadmin policy", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.path === "/product-categories/:id/delete-with-reassign",
    );

    expect(route).toBeDefined();
    expect(route?.config.auth).toEqual({ scope: [] });
    expect(route?.config.middlewares).toBeUndefined();
    expect(route?.config.policies).toEqual([
      {
        name: "global::role-based",
        config: { roles: ["Superadmin"] },
      },
    ]);
  });
});
