import routeConfig from "../routes/plugin-user";

describe("plugin user operational routes", () => {
  it("keeps arbitrary user creation behind user-management capability", () => {
    const route = routeConfig.routes.find((entry) => entry.path === "/sp/plugin-users");
    expect(route?.config.policies).toEqual([
      {
        name: "global::require-capability",
        config: { capability: "system.users.manage" },
      },
    ]);
  });

  it("requires customer-wallet search capability for sanitized customer search", () => {
    const route = routeConfig.routes.find((entry) => entry.path === "/sp/customers/search");
    expect(route?.config.policies).toEqual([
      {
        name: "global::require-capability",
        config: { capability: "wallet.customer.search" },
      },
    ]);
  });
});
