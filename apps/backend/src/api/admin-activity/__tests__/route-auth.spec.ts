import routes from "../routes/custom-router";
import { ROLE_NAMES } from "../../../utils/roles";

function allowedRoles(path: string) {
  const route = routes.routes.find((entry) => entry.path === path);
  return route?.config?.policies?.[0]?.config?.roles;
}

describe("admin activity route authorization", () => {
  it("keeps global audit routes Superadmin-only", () => {
    for (const path of [
      "/admin-activities/me",
      "/admin-activities/user/:userId",
      "/admin-activities/product/:productId",
      "/admin-activities/report",
    ]) {
      expect(allowedRoles(path)).toEqual([ROLE_NAMES.SUPERADMIN]);
    }
  });

  it("retains Founder access only for order-scoped reporting", () => {
    expect(allowedRoles("/admin-activities/order/:orderId")).toEqual([
      ROLE_NAMES.SUPERADMIN,
      ROLE_NAMES.FOUNDER,
    ]);
  });
});
