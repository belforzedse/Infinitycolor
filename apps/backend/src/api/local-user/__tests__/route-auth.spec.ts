import { __localUserRouteTestUtils } from "../routes/local-user";
import customRouteConfig from "../routes/custom-router";

const userManagementPolicy = [
  {
    name: "global::require-capability",
    config: { capability: "system.users.manage" },
  },
];

describe("legacy user route authorization", () => {
  it("requires user-management capability for all legacy core CRUD", () => {
    expect(__localUserRouteTestUtils.adminRouteConfig.policies).toEqual(userManagementPolicy);
  });

  it("requires user-management capability for legacy create and update helpers", () => {
    for (const path of ["/sp/local-users", "/sp/local-users/:id"]) {
      const route = customRouteConfig.routes.find((entry) => entry.path === path);
      expect(route?.config.policies).toEqual(userManagementPolicy);
    }
  });
});
