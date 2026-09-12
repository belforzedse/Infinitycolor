import { ADMIN_ROLE_IDS, hasCapability } from "@repo/auth-core";

describe("order.address.update capability", () => {
  it("starts at Seller 2 and is inherited by higher operational roles", () => {
    expect(hasCapability("support", "order.address.update")).toBe(false);
    expect(hasCapability("editor", "order.address.update")).toBe(false);
    expect(hasCapability("seller1", "order.address.update")).toBe(false);
    for (const role of ["seller2", "store_manager", "store_manager_2", "finance", "founder", "superadmin"] as const) {
      expect(hasCapability(role, "order.address.update")).toBe(true);
    }
    expect(ADMIN_ROLE_IDS).toContain("seller2");
  });
});
