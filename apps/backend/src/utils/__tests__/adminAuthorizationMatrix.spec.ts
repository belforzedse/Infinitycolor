import {
  ADMIN_CAPABILITIES,
  ADMIN_ROLE_IDS,
  capabilitiesForRole,
  hasCapability,
  normalizeAdminRole,
} from "@repo/auth-core";

describe("canonical admin capability matrix", () => {
  const customerCapabilities = [
    "storefront.checkout.use",
    "storefront.orders.read-own",
    "storefront.wallet.read-own",
  ] as const;

  it.each(ADMIN_ROLE_IDS)("gives %s the normal customer storefront contract", (role) => {
    for (const capability of customerCapabilities) {
      expect(hasCapability(role, capability)).toBe(true);
    }
  });

  it("keeps Editor admin access blog-only", () => {
    const capabilities = capabilitiesForRole("editor");
    expect(capabilities).toContain("content.blog.read");
    expect(capabilities).toContain("content.blog.banners.manage");
    expect(capabilities).not.toContain("product.read");
    expect(capabilities).not.toContain("order.read");
    expect(capabilities).not.toContain("content.stories.manage");
    expect(capabilities).not.toContain("content.faq.manage");
  });

  it("models Store Manager and Finance as separate Seller 2 branches", () => {
    expect(hasCapability("seller2", "order.status.update")).toBe(true);
    expect(hasCapability("seller2", "order.notes.update")).toBe(true);
    expect(hasCapability("seller2", "report.product.read")).toBe(false);
    expect(hasCapability("store_manager", "category.update")).toBe(true);
    expect(hasCapability("store_manager", "order.status.update")).toBe(true);
    expect(hasCapability("store_manager", "report.product.read")).toBe(false);
    expect(hasCapability("finance", "category.update")).toBe(true);
    expect(hasCapability("finance", "report.finance.read")).toBe(true);
    expect(hasCapability("finance", "report.product.read")).toBe(true);
    // Finance does not gain status updates from the Store Manager branch; it
    // inherits them from Seller 2 now that status lives on Seller 2.
    expect(hasCapability("finance", "order.status.update")).toBe(true);
  });

  it("makes Founder the exact business union plus Founder capabilities", () => {
    const founder = new Set(capabilitiesForRole("founder"));
    for (const inheritedRole of ["store_manager", "finance"] as const) {
      for (const capability of capabilitiesForRole(inheritedRole)) {
        expect(founder.has(capability)).toBe(true);
      }
    }
    expect(founder.has("order.manual.create")).toBe(true);
    expect(founder.has("wallet.adjust")).toBe(true);
    expect(founder.has("system.roles.manage")).toBe(false);
    expect(founder.has("order.cancel")).toBe(false);
  });

  it("reserves scheduling for Superadmin and immediate publication for Seller 1", () => {
    expect(hasCapability("seller1", "product.publish")).toBe(true);
    expect(hasCapability("store_manager", "product.schedule")).toBe(false);
    expect(hasCapability("founder", "product.schedule")).toBe(false);
    expect(hasCapability("superadmin", "product.schedule")).toBe(true);
  });

  it("denies unknown roles and gives Superadmin every registered capability", () => {
    expect(normalizeAdminRole("mystery-role")).toBeNull();
    expect(capabilitiesForRole("mystery-role")).toEqual([]);
    expect(new Set(capabilitiesForRole("superadmin"))).toEqual(new Set(ADMIN_CAPABILITIES));
  });
});
