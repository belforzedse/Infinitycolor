import { canRoleAccessPath } from "../roleAccess";
import { getSalesNavForRole, SALES_NAV_ITEMS } from "../salesNav";
import { getSidebarItemsForRole } from "../superAdminSidebar";

/**
 * Moving the sales analytics from /reports/* into /sales/* is the one part of
 * this refactor that could widen access, so the permission matrix is pinned
 * here explicitly.
 *
 * Note the e2e `@permissions` suite runs against the legacy super-admin tree in
 * apps/frontend (it uses `storefrontBaseURL()`), so it does not cover this app.
 * These assertions are the regression guard for apps/admin.
 */

const FOUNDER_ALLOWED_SALES = [
  "/sales",
  "/sales/breakdown",
  "/sales/products",
  "/sales/funnel",
  "/sales/geography",
  "/sales/liquidity",
  "/sales/gateways",
  "/sales/traffic",
  "/sales/carts",
];

describe("canRoleAccessPath", () => {
  describe("Superadmin", () => {
    it("reaches every sales destination", () => {
      for (const item of SALES_NAV_ITEMS) {
        expect(canRoleAccessPath("Superadmin", item.href)).toBe(true);
      }
      expect(canRoleAccessPath("Superadmin", "/settings/activity")).toBe(true);
    });
  });

  describe("Founder", () => {
    it("keeps the sales reports it could already view", () => {
      for (const path of FOUNDER_ALLOWED_SALES) {
        expect(canRoleAccessPath("Founder", path)).toBe(true);
      }
    });

    it("inherits product, finance, traffic, and carts reporting", () => {
      for (const path of FOUNDER_ALLOWED_SALES) {
        expect(canRoleAccessPath("Founder", path)).toBe(true);
      }
    });

    it("still cannot reach the staff activity log after it moved to settings", () => {
      expect(canRoleAccessPath("Founder", "/reports/admin-activity")).toBe(false);
      expect(canRoleAccessPath("Founder", "/settings/activity")).toBe(false);
    });

    it("applies the same capabilities to compatible legacy report paths", () => {
      expect(canRoleAccessPath("Founder", "/reports/traffic")).toBe(true);
      expect(canRoleAccessPath("Founder", "/carts")).toBe(true);
      expect(canRoleAccessPath("Founder", "/reports/liquidity")).toBe(true);
      expect(canRoleAccessPath("Founder", "/reports/gateway-liquidity")).toBe(true);
    });
  });

  describe("Store manager", () => {
    it("can reach product reporting but not broader sales destinations", () => {
      expect(canRoleAccessPath("Store manager", "/sales/products")).toBe(true);
      for (const item of SALES_NAV_ITEMS.filter((item) => item.href !== "/sales/products")) {
        expect(canRoleAccessPath("Store manager", item.href)).toBe(false);
      }
      for (const path of ["/reports", "/reports/sales", "/carts"]) {
        expect(canRoleAccessPath("Store manager", path)).toBe(false);
      }
    });

    it("retains its operational resources", () => {
      for (const path of ["/orders", "/products"]) {
        expect(canRoleAccessPath("Store manager", path)).toBe(true);
      }
      for (const path of ["/shipping", "/coupons", "/general-discounts"]) {
        expect(canRoleAccessPath("Store manager", path)).toBe(false);
      }
    });
  });

  describe("Seller roles", () => {
    it("keeps Seller 1 in the non-destructive catalog workspace", () => {
      expect(canRoleAccessPath("Seller 1", "/products")).toBe(true);
      expect(canRoleAccessPath("Seller 1", "/products/add")).toBe(true);
      expect(canRoleAccessPath("Seller 1", "/products/categories")).toBe(false);
      expect(canRoleAccessPath("Seller 1", "/orders")).toBe(false);
    });

    it("adds categories and read-only order pages for Seller 2", () => {
      expect(canRoleAccessPath("Seller 2", "/products/categories")).toBe(true);
      expect(canRoleAccessPath("Seller 2", "/orders")).toBe(true);
      expect(canRoleAccessPath("Seller 2", "/orders/add")).toBe(false);
      expect(canRoleAccessPath("Seller 2", "/sales")).toBe(false);
    });
  });

  describe("Finance", () => {
    it("inherits Seller 2 and receives financial reports without traffic or wallets", () => {
      for (const path of [
        "/products",
        "/products/categories",
        "/orders",
        "/sales",
        "/sales/products",
        "/sales/liquidity",
        "/sales/carts",
      ]) {
        expect(canRoleAccessPath("Finance", path)).toBe(true);
      }
      for (const path of ["/sales/traffic", "/sales/funnel", "/wallets", "/orders/add"]) {
        expect(canRoleAccessPath("Finance", path)).toBe(false);
      }
    });
  });

  describe("Editor", () => {
    it("has a blog-only admin workspace plus self-service account access", () => {
      expect(canRoleAccessPath("Editor", "/blog")).toBe(true);
      expect(canRoleAccessPath("Editor", "/account")).toBe(true);
      expect(canRoleAccessPath("Editor", "/products")).toBe(false);
      expect(canRoleAccessPath("Editor", "/orders")).toBe(false);
      expect(canRoleAccessPath("Editor", "/stories")).toBe(false);
      expect(canRoleAccessPath("Editor", "/faq")).toBe(false);
      expect(canRoleAccessPath("Editor", "/sales")).toBe(false);
      expect(canRoleAccessPath("Editor", "/settings/activity")).toBe(false);
    });
  });

  it("denies unknown roles and unknown routes by default", () => {
    expect(canRoleAccessPath("Manager", "/orders")).toBe(false);
    expect(canRoleAccessPath("Editor", "/unregistered-area")).toBe(false);
    expect(canRoleAccessPath("Superadmin", "/unregistered-area")).toBe(true);
  });
});

describe("getSalesNavForRole", () => {
  it("matches the route guard exactly for every role", () => {
    for (const role of [
      "Superadmin",
      "Founder",
      "Finance",
      "Store manager",
      "Seller 2",
      "Seller 1",
      "Editor",
    ]) {
      const nav = getSalesNavForRole(role);
      for (const item of nav) {
        expect(canRoleAccessPath(role, item.href)).toBe(true);
      }
      // Nothing the guard allows is silently missing from the navigation.
      const allowed = SALES_NAV_ITEMS.filter((item) =>
        canRoleAccessPath(role, item.href),
      );
      expect(nav.map((item) => item.id)).toEqual(allowed.map((item) => item.id));
    }
  });

  it("gives a Founder exactly the sales reports it may view", () => {
    expect(getSalesNavForRole("Founder").map((item) => item.href)).toEqual(
      FOUNDER_ALLOWED_SALES,
    );
  });

  it("gives a Store manager product reporting only", () => {
    expect(getSalesNavForRole("Store manager").map((item) => item.href)).toEqual([
      "/sales/products",
    ]);
  });

  it("gives Finance its reporting branch without Founder traffic", () => {
    expect(getSalesNavForRole("Finance").map((item) => item.href)).toEqual([
      "/sales",
      "/sales/breakdown",
      "/sales/products",
      "/sales/geography",
      "/sales/liquidity",
      "/sales/gateways",
      "/sales/carts",
    ]);
  });
});

describe("sidebar", () => {
  const parentIds = (role: string | null) =>
    getSidebarItemsForRole(role).map((item) => item.id);

  it("no longer exposes carts as a top-level destination", () => {
    // It lives inside the Sales hub now, where it inherits /sales denial.
    expect(parentIds("Superadmin")).not.toContain("carts");
  });

  it("replaces the unreachable reports group with a Sales hub that has a landing page", () => {
    const sales = getSidebarItemsForRole("Superadmin").find(
      (item) => item.id === "sales",
    );
    expect(sales).toBeDefined();
    // The old `reports` node had no href, which made /reports unreachable and
    // orphaned the liquidity reports that only linked from it.
    expect(sales?.href).toBe("/sales");
  });

  it("promotes the Store Manager's only report to a direct destination", () => {
    expect(parentIds("Store manager")).toContain("sales-products");
    expect(parentIds("Store manager")).not.toContain("sales");
  });

  it("derives the Founder sales children from the permission rules", () => {
    const sales = getSidebarItemsForRole("Founder").find(
      (item) => item.id === "sales",
    );
    expect(sales?.children.map((child) => child.href)).toEqual(
      FOUNDER_ALLOWED_SALES,
    );
  });

  it("surfaces the liquidity reports that were previously unreachable", () => {
    const sales = getSidebarItemsForRole("Superadmin").find(
      (item) => item.id === "sales",
    );
    const hrefs = sales?.children.map((child) => child.href) ?? [];
    expect(hrefs).toContain("/sales/liquidity");
    expect(hrefs).toContain("/sales/gateways");
  });

  it("promotes Editor blog children to icon-backed top-level destinations", () => {
    const items = getSidebarItemsForRole("Editor");
    expect(items.map((item) => item.id)).toEqual([
      "dashboard",
      "blog-dashboard",
      "blog-posts",
      "blog-categories",
      "blog-category-banners",
      "blog-tags",
      "blog-authors",
      "blog-comments",
    ]);
    expect(items.every((item) => item.icon && item.children.length === 0)).toBe(true);
  });

  it("promotes focused catalog destinations for seller and Store Manager roles", () => {
    for (const role of ["Seller 1", "Seller 2", "Store Manager"]) {
      const items = getSidebarItemsForRole(role);
      expect(items.some((item) => item.id === "manage-products")).toBe(false);
      expect(items.some((item) => item.id === "products" && item.icon)).toBe(true);
      expect(items.some((item) => item.id === "product-size-guide" && item.icon)).toBe(true);
    }
  });

  it("keeps every role's top-level information architecture within a useful range", () => {
    const expectedCounts: Record<string, number> = {
      Editor: 8,
      "Seller 1": 6,
      "Seller 2": 8,
      "Store Manager": 9,
      Finance: 4,
      Founder: 5,
      Superadmin: 11,
    };

    for (const [role, count] of Object.entries(expectedCounts)) {
      expect(getSidebarItemsForRole(role)).toHaveLength(count);
    }
  });

  it("groups dense Superadmin commerce and customer controls", () => {
    const ids = parentIds("Superadmin");
    expect(ids).toContain("store-operations");
    expect(ids).toContain("customer-operations");
    expect(ids).not.toContain("payment-methods");
    expect(ids).not.toContain("wallets");
  });
});
