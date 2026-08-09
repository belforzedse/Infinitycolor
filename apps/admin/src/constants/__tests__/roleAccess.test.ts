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

  describe("Editor", () => {
    it("is denied new routes by default (allow-list)", () => {
      expect(canRoleAccessPath("Editor", "/blog")).toBe(true);
      expect(canRoleAccessPath("Editor", "/sales")).toBe(false);
      expect(canRoleAccessPath("Editor", "/settings/activity")).toBe(false);
    });
  });
});

describe("getSalesNavForRole", () => {
  it("matches the route guard exactly for every role", () => {
    for (const role of ["Superadmin", "Founder", "Store manager", "Editor"]) {
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

  it("shows the product-report Sales hub to a Store manager", () => {
    expect(parentIds("Store manager")).toContain("sales");
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
});
