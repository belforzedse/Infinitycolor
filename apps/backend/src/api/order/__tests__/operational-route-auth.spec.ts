import routeConfig from "../routes/custom-router";
import { ROLE_NAMES, STORE_MANAGER_PLUS_ROLES } from "../../../utils/roles";

describe("order operational route authorization", () => {
  it.each([
    "/orders/:id/anipo-barcode",
    "/orders/:id/admin/adjust-items",
    "/orders/:id/admin/notes",
    "/orders/:id/admin/transition",
    "/orders/:id/admin/cancel",
    "/orders/:id/admin/void-barcode",
    "/orders/:id/decrement-stock-manual",
  ])("limits %s to Store manager plus roles", (path) => {
    const route = routeConfig.routes.find((entry) => entry.path === path);
    expect(route?.config.policies).toEqual([
      {
        name: "global::role-based",
        config: { roles: STORE_MANAGER_PLUS_ROLES },
      },
    ]);
  });

  it("keeps raw payment-operation status Superadmin-only", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.path === "/orders/:id/admin/payment-operations/:operationId",
    );
    expect(route?.config.policies).toEqual([
      {
        name: "global::role-based",
        config: { roles: [ROLE_NAMES.SUPERADMIN] },
      },
    ]);
  });
});
