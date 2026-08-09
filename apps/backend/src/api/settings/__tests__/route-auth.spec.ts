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
});
