import routeConfig from "../routes/plugin-user";
import { ROLE_NAMES, STORE_MANAGER_PLUS_ROLES } from "../../../utils/roles";

describe("plugin user operational routes", () => {
  it("keeps arbitrary user creation Superadmin-only", () => {
    const route = routeConfig.routes.find((entry) => entry.path === "/sp/plugin-users");
    expect(route?.config.policies).toEqual([
      {
        name: "global::role-based",
        config: { roles: [ROLE_NAMES.SUPERADMIN] },
      },
    ]);
  });

  it("allows manager-plus roles to use sanitized customer search", () => {
    const route = routeConfig.routes.find((entry) => entry.path === "/sp/customers/search");
    expect(route?.config.policies).toEqual([
      {
        name: "global::role-based",
        config: { roles: STORE_MANAGER_PLUS_ROLES },
      },
    ]);
  });
});
