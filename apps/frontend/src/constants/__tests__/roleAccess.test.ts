import {
  canFounderAccessPath,
  canEditorAccessPath,
  canRoleAccessPath,
  canStoreManagerAccessPath,
  getRoleAdminLandingPath,
  isEditorRole,
  isFounderRole,
  isStoreManagerRole,
  FOUNDER_HIDDEN_PARENT_IDS,
} from "@/constants/roleAccess";

describe("roleAccess - Founder rules", () => {
  describe("isFounderRole", () => {
    it.each(["Founder", "founder", " FOUNDER ", "founders" /* alias handled server-side */])(
      "recognizes %p as Founder when normalized",
      (value) => {
        // Only exact 'founder' (case/space-insensitive) is treated as Founder on the client.
        const expected = value.trim().toLowerCase() === "founder";
        expect(isFounderRole(value)).toBe(expected);
      },
    );

    it("returns false for other roles and nullish", () => {
      expect(isFounderRole("Superadmin")).toBe(false);
      expect(isFounderRole("Store manager")).toBe(false);
      expect(isFounderRole(null)).toBe(false);
      expect(isFounderRole(undefined)).toBe(false);
    });
  });

  describe("canFounderAccessPath", () => {
    it("blocks restricted sections", () => {
      const blocked = [
        "/super-admin/customization",
        "/super-admin/customization/visual-identity",
        "/super-admin/blog",
        "/super-admin/blog/posts",
        "/super-admin/faq/questions",
        "/super-admin/stories",
        "/super-admin/stories/add",
        "/super-admin/settings",
        "/super-admin/settings/general",
        "/super-admin/payment-methods",
        "/super-admin/carts",
        "/super-admin/orders/add",
        "/super-admin/products/homepage",
        "/super-admin/shipping/provinces",
        "/super-admin/users",
        "/super-admin/users/edit/5",
        "/super-admin/reports/traffic",
        "/super-admin/reports/admin-activity",
        "/super-admin/reports/admin-activity/12",
      ];
      for (const path of blocked) {
        expect(canFounderAccessPath(path)).toBe(false);
      }
    });

    it("allows operational sections and the sales report", () => {
      const allowed = [
        "/super-admin",
        "/super-admin/orders",
        "/super-admin/orders/edit/99",
        "/super-admin/products",
        "/super-admin/coupons",
        "/super-admin/general-discounts",
        "/super-admin/shipping",
        "/super-admin/reports/product-sales",
      ];
      for (const path of allowed) {
        expect(canFounderAccessPath(path)).toBe(true);
      }
    });

    it("does not treat a prefix collision as a match", () => {
      // '/super-admin/users-something' should not be blocked by the '/super-admin/users' rule.
      expect(canFounderAccessPath("/super-admin/users-export")).toBe(true);
    });
  });

  it("hides the expected sidebar parents", () => {
    expect([...FOUNDER_HIDDEN_PARENT_IDS].sort()).toEqual(
      [
        "blog",
        "carts",
        "customization",
        "faq",
        "payment-methods",
        "settings",
        "stories",
        "users",
      ].sort(),
    );
  });
});

describe("roleAccess - Store manager rules", () => {
  it("recognizes Store manager aliases", () => {
    expect(isStoreManagerRole("Store manager")).toBe(true);
    expect(isStoreManagerRole("store-manager")).toBe(true);
    expect(isStoreManagerRole("Superadmin")).toBe(false);
  });

  it("allows operational commerce and blocks control-plane routes", () => {
    for (const path of [
      "/super-admin/products",
      "/super-admin/products/attributes",
      "/super-admin/products/comments",
      "/super-admin/coupons",
      "/super-admin/general-discounts",
      "/super-admin/shipping",
      "/super-admin/orders/edit/10",
    ]) {
      expect(canStoreManagerAccessPath(path)).toBe(true);
    }

    for (const path of [
      "/super-admin/payment-methods",
      "/super-admin/users",
      "/super-admin/reports/product-sales",
      "/super-admin/shipping/provinces",
      "/super-admin/orders/add",
      "/super-admin/purgeall",
    ]) {
      expect(canStoreManagerAccessPath(path)).toBe(false);
    }
  });
});

describe("roleAccess - Editor rules", () => {
  it("limits Editors to the blog workspace", () => {
    expect(isEditorRole(" Editor ")).toBe(true);
    expect(canEditorAccessPath("/super-admin/blog/posts/12")).toBe(true);
    expect(canEditorAccessPath("/super-admin/products")).toBe(false);
    expect(canRoleAccessPath("Editor", "/super-admin/payment-methods")).toBe(false);
    expect(getRoleAdminLandingPath("Editor")).toBe("/super-admin/blog");
  });
});
