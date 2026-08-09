import routes from "../routes/custom-router";

function requiredCapability(path: string) {
  const route = routes.routes.find((entry) => entry.path === path);
  return route?.config?.policies?.[0]?.config?.capability;
}

describe("admin activity route authorization", () => {
  it("keeps global audit routes behind system audit access", () => {
    for (const path of [
      "/admin-activities/me",
      "/admin-activities/user/:userId",
      "/admin-activities/product/:productId",
      "/admin-activities/report",
    ]) {
      expect(requiredCapability(path)).toBe("system.audit.read");
    }
  });

  it("uses the narrower order-audit capability for order-scoped reporting", () => {
    expect(requiredCapability("/admin-activities/order/:orderId")).toBe("order.audit.read");
  });
});
