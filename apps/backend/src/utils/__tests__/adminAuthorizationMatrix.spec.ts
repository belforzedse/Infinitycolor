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

  it("limits Support to product reviews and issue reports", () => {
    const capabilities = capabilitiesForRole("support");
    expect(capabilities).toContain("system.reviews.manage");
    expect(capabilities).toContain("system.issueReports.manage");
    expect(capabilities).not.toContain("product.read");
    expect(capabilities).not.toContain("order.read");
    expect(capabilities).not.toContain("content.blog.read");
    expect(capabilities).not.toContain("wallet.read");
    expect(capabilities).not.toContain("system.users.manage");
    expect(normalizeAdminRole("Support")).toBe("support");
  });

  it("keeps review moderation on Support and Superadmin only", () => {
    for (const role of ADMIN_ROLE_IDS) {
      expect(hasCapability(role, "system.reviews.manage")).toBe(
        role === "support" || role === "superadmin",
      );
      expect(hasCapability(role, "system.issueReports.manage")).toBe(
        role === "support" || role === "superadmin",
      );
    }
  });

  it("gives Editor blog and stories without commerce access", () => {
    const capabilities = capabilitiesForRole("editor");
    expect(capabilities).toContain("content.blog.read");
    expect(capabilities).toContain("content.blog.banners.manage");
    expect(capabilities).toContain("content.stories.manage");
    expect(capabilities).not.toContain("product.read");
    expect(capabilities).not.toContain("order.read");
    expect(capabilities).not.toContain("content.faq.manage");
  });

  it("starts stories management at Seller 2 and Editor, not Seller 1", () => {
    expect(hasCapability("seller1", "content.stories.manage")).toBe(false);
    expect(hasCapability("editor", "content.stories.manage")).toBe(true);
    expect(hasCapability("seller2", "content.stories.manage")).toBe(true);
    expect(hasCapability("store_manager", "content.stories.manage")).toBe(true);
    expect(hasCapability("store_manager_2", "content.stories.manage")).toBe(true);
    expect(hasCapability("finance", "content.stories.manage")).toBe(true);
    expect(hasCapability("founder", "content.stories.manage")).toBe(true);
    expect(hasCapability("superadmin", "content.stories.manage")).toBe(true);
  });

  it("models Store Manager and Finance as separate Seller 2 branches", () => {
    expect(hasCapability("seller2", "order.status.update")).toBe(true);
    expect(hasCapability("seller2", "order.notes.update")).toBe(true);
    expect(hasCapability("seller2", "order.cancel")).toBe(true);
    expect(hasCapability("seller1", "order.cancel")).toBe(false);
    expect(hasCapability("store_manager", "order.cancel")).toBe(true);
    expect(hasCapability("store_manager_2", "order.cancel")).toBe(true);
    expect(hasCapability("finance", "order.cancel")).toBe(true);
    expect(hasCapability("seller2", "report.product.read")).toBe(false);
    expect(hasCapability("store_manager", "category.update")).toBe(true);
    expect(hasCapability("store_manager", "order.status.update")).toBe(true);
    expect(hasCapability("store_manager", "report.product.read")).toBe(false);
    const storeManager = new Set(capabilitiesForRole("store_manager"));
    const storeManager2 = new Set(capabilitiesForRole("store_manager_2"));
    expect(
      [...storeManager].every((capability) => storeManager2.has(capability)),
    ).toBe(true);
    expect(
      [...storeManager2]
        .filter((capability) => !storeManager.has(capability))
        .sort(),
    ).toEqual([
      "wallet.adjust",
      "wallet.customer.search",
      "wallet.history.read",
      "wallet.read",
    ]);
    expect(hasCapability("store_manager_2", "report.product.read")).toBe(false);
    expect(hasCapability("store_manager_2", "system.users.manage")).toBe(false);
    expect(hasCapability("finance", "category.update")).toBe(true);
    expect(hasCapability("finance", "report.finance.read")).toBe(true);
    expect(hasCapability("finance", "report.product.read")).toBe(true);
    for (const capability of ["report.excel.export", "report.wallet.export", "report.inventory-history.export"] as const) {
      expect(hasCapability("finance", capability)).toBe(false);
      expect(hasCapability("founder", capability)).toBe(false);
      expect(hasCapability("superadmin", capability)).toBe(true);
      expect(hasCapability("store_manager_2", capability)).toBe(false);
      expect(hasCapability("seller2", capability)).toBe(false);
    }
    expect(hasCapability("finance", "system.audit.read")).toBe(false);
    expect(hasCapability("founder", "system.audit.read")).toBe(false);
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
    expect(founder.has("system.modelApplications.manage")).toBe(true);
    expect(founder.has("category.delete")).toBe(true);
    expect(hasCapability("seller2", "category.delete")).toBe(false);
    expect(hasCapability("finance", "category.delete")).toBe(false);
    expect(founder.has("system.roles.manage")).toBe(false);
    expect(founder.has("order.cancel")).toBe(true);
    expect(hasCapability("finance", "system.modelApplications.manage")).toBe(false);
  });

  it("starts scheduling at Seller 2 while immediate publication begins at Seller 1", () => {
    expect(hasCapability("seller1", "product.publish")).toBe(true);
    expect(hasCapability("editor", "product.schedule")).toBe(false);
    expect(hasCapability("support", "product.schedule")).toBe(false);
    expect(hasCapability("seller1", "product.schedule")).toBe(false);
    // Every role on the Seller 2 branch and above. Listed explicitly rather than
    // sliced by position, since Editor and Support are standalone branches that
    // sit outside the seller inheritance chain.
    const seller2AndAbove = [
      "seller2",
      "store_manager",
      "store_manager_2",
      "finance",
      "founder",
      "superadmin",
    ] as const satisfies readonly (typeof ADMIN_ROLE_IDS)[number][];
    for (const role of seller2AndAbove) {
      expect(hasCapability(role, "product.schedule")).toBe(true);
    }
  });

  it("denies unknown roles and gives Superadmin every registered capability", () => {
    expect(normalizeAdminRole("mystery-role")).toBeNull();
    expect(capabilitiesForRole("mystery-role")).toEqual([]);
    expect(new Set(capabilitiesForRole("superadmin"))).toEqual(new Set(ADMIN_CAPABILITIES));
  });
});
