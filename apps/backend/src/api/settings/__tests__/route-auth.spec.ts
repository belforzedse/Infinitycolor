import routeConfig from "../routes/custom-router";

describe("site settings route authorization", () => {
  it("keeps the legacy settings update route behind settings management", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.method === "PUT" && entry.path === "/site-settings",
    );
    expect(route?.config.policies).toEqual([
      {
        name: "global::require-capability",
        config: { capability: "system.settings.manage" },
      },
    ]);
  });

  it.each([
    ["GET", "/settings/homepage-products"],
    ["PUT", "/settings/homepage-products"],
    ["GET", "/settings/gif-promo-products"],
    ["PUT", "/settings/gif-promo-products"],
    ["GET", "/settings/homepage-custom-section"],
    ["PUT", "/settings/homepage-custom-section"],
  ])(
    "keeps %s %s scoped to product.homepage.manage, not the broader settings capability",
    (method, path) => {
      const route = routeConfig.routes.find(
        (entry) => entry.method === method && entry.path === path,
      );
      expect(route?.config.policies).toEqual([
        {
          name: "global::require-capability",
          config: { capability: "product.homepage.manage" },
        },
      ]);
    },
  );
});
