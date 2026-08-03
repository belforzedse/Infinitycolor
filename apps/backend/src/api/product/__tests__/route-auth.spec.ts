import routeConfig from "../routes/custom-router";
import { STORE_MANAGER_PLUS_ROLES } from "../../../utils/roles";

describe("product operational routes", () => {
  it("allows Store manager plus roles to generate variation combinations", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.path === "/products/:id/variation-combinations",
    );

    expect(route).toBeDefined();
    expect(route?.config.auth).toEqual({ scope: [] });
    expect(route?.config.policies).toEqual([
      {
        name: "global::role-based",
        config: { roles: STORE_MANAGER_PLUS_ROLES },
      },
    ]);
  });
});
