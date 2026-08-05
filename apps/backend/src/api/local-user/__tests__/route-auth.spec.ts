import { __localUserRouteTestUtils } from "../routes/local-user";
import customRouteConfig from "../routes/custom-router";
import { ROLE_NAMES } from "../../../utils/roles";

const superadminPolicy = [
  {
    name: "global::role-based",
    config: { roles: [ROLE_NAMES.SUPERADMIN] },
  },
];

describe("legacy user route authorization", () => {
  it("keeps all legacy core CRUD Superadmin-only", () => {
    expect(__localUserRouteTestUtils.adminRouteConfig.policies).toEqual(superadminPolicy);
  });

  it("keeps legacy create and update helpers Superadmin-only", () => {
    for (const path of ["/sp/local-users", "/sp/local-users/:id"]) {
      const route = customRouteConfig.routes.find((entry) => entry.path === path);
      expect(route?.config.policies).toEqual(superadminPolicy);
    }
  });
});
