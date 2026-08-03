import routeConfig from "../routes/custom-router";
import { ROLE_NAMES } from "../../../utils/roles";

describe("site settings route authorization", () => {
  it("keeps the legacy settings update route Superadmin-only", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.method === "PUT" && entry.path === "/site-settings",
    );
    expect(route?.config.policies).toEqual([
      {
        name: "global::role-based",
        config: { roles: [ROLE_NAMES.SUPERADMIN] },
      },
    ]);
  });
});
