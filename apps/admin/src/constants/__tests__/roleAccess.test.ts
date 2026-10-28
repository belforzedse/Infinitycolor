import { canRoleAccessPath, isStoreManagerRole } from "../roleAccess";
import {
  getSalesNavForRole,
  SALES_NAV_ITEMS,
} from "../salesNav";
import { getSidebarItemsForRole } from "../superAdminSidebar";
import {
  ADMIN_ROLE_DEFINITIONS,
  ADMIN_ROLE_IDS,
  capabilitiesForRole,
} from "@repo/auth-core";

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
  "/sales/products",
  "/sales/breakdown",
  "/sales/traffic",
  "/sales/liquidity",
];

describe("canRoleAccessPath", () => {
  describe("Superadmin", () => {
    it("reaches every sales destination", () => {
      for (const item of SALES_NAV_ITEMS) {
        expect(canRoleAccessPath("Superadmin", item.href)).toBe(true);
      }
      expect(canRoleAccessPath("Superadmin", "/sales/activity")).toBe(true);
    });

    it("shares the issue report workspace with Support only", () => {
      for (const role of ADMIN_ROLE_IDS) {
        expect(canRoleAccessPath(role, "/issue-reports")).toBe(
          role === "superadmin" || role === "support",
        );
      }
    });

    it("reaches the model application inbox", () => {
      expect(canRoleAccessPath("Superadmin", "/model-applications")).toBe(true);
    });
  });

  describe("Founder", () => {
    it("keeps the sales reports it could already view", () => {
      for (const path of FOUNDER_ALLOWED_SALES) {
        expect(canRoleAccessPath("Founder", path)).toBe(true);
      }
    });

    it("inherits product, finance, and behavior reporting", () => {
      for (const path of FOUNDER_ALLOWED_SALES) {
        expect(canRoleAccessPath("Founder", path)).toBe(true);
      }
    });

    it("still cannot reach the staff activity log after it moved into sales", () => {
      expect(canRoleAccessPath("Founder", "/reports/admin-activity")).toBe(
        false,
      );
      expect(canRoleAccessPath("Founder", "/settings/activity")).toBe(false);
      expect(canRoleAccessPath("Founder", "/sales/activity")).toBe(false);
    });

    it("can manage stories", () => {
      expect(canRoleAccessPath("Founder", "/stories")).toBe(true);
      expect(canRoleAccessPath("Founder", "/stories/add")).toBe(true);
    });

    it("applies the same capabilities to compatible legacy report paths", () => {
      expect(canRoleAccessPath("Founder", "/reports/traffic")).toBe(true);
      expect(canRoleAccessPath("Founder", "/carts")).toBe(true);
      expect(canRoleAccessPath("Founder", "/orders/carts")).toBe(true);
      expect(canRoleAccessPath("Founder", "/reports/liquidity")).toBe(true);
      expect(canRoleAccessPath("Founder", "/reports/gateway-liquidity")).toBe(
        true,
      );
    });

    it("can open the model application inbox", () => {
      expect(canRoleAccessPath("Founder", "/model-applications")).toBe(true);
    });
  });

  describe("Store manager", () => {
    it("has no sales analytics destinations", () => {
      expect(canRoleAccessPath("Store manager", "/sales/products")).toBe(false);
      for (const item of SALES_NAV_ITEMS) {
        expect(canRoleAccessPath("Store manager", item.href)).toBe(false);
      }
      for (const path of ["/sales", "/reports", "/reports/sales", "/carts"]) {
        expect(canRoleAccessPath("Store manager", path)).toBe(false);
      }
    });

    it("retains its operational resources including stories", () => {
      for (const path of ["/orders", "/orders/reserve", "/products", "/stories"]) {
        expect(canRoleAccessPath("Store manager", path)).toBe(true);
      }
      for (const path of ["/shipping", "/coupons", "/general-discounts"]) {
        expect(canRoleAccessPath("Store manager", path)).toBe(false);
      }
      const orders = getSidebarItemsForRole("Store manager").find(
        (item) => item.id === "orders",
      );
      expect(orders?.children.map((child) => child.href)).toEqual([
        "/orders",
        "/orders/reserve",
      ]);
    });
  });

  describe("Store Manager 2", () => {
    it("keeps Store Manager routes and adds only the wallet workspace", () => {
      for (const path of ["/orders", "/products", "/wallets", "/stories"]) {
        expect(canRoleAccessPath("Store Manager 2", path)).toBe(true);
      }
      for (const path of [
        "/users",
        "/sales",
        "/settings",
        "/payment-methods",
      ]) {
        expect(canRoleAccessPath("Store Manager 2", path)).toBe(false);
      }
      expect(isStoreManagerRole("store-manager-2")).toBe(true);
    });
  });

  describe("Seller roles", () => {
    it("lets Seller 1 stay in the catalog workspace without stories", () => {
      expect(canRoleAccessPath("Seller 1", "/products")).toBe(true);
      expect(canRoleAccessPath("Seller 1", "/products/add")).toBe(true);
      expect(canRoleAccessPath("Seller 1", "/products/categories")).toBe(false);
      expect(canRoleAccessPath("Seller 1", "/orders")).toBe(false);
      expect(canRoleAccessPath("Seller 1", "/stories")).toBe(false);
      expect(canRoleAccessPath("Seller 1", "/stories/add")).toBe(false);
    });

    it("adds categories, operational order pages, and stories for Seller 2", () => {
      expect(canRoleAccessPath("Seller 2", "/products/categories")).toBe(true);
      expect(canRoleAccessPath("Seller 2", "/orders")).toBe(true);
      expect(canRoleAccessPath("Seller 2", "/orders/add")).toBe(false);
      expect(canRoleAccessPath("Seller 2", "/sales")).toBe(false);
      expect(canRoleAccessPath("Seller 2", "/sales/products")).toBe(false);
      expect(canRoleAccessPath("Seller 2", "/stories")).toBe(true);
      expect(canRoleAccessPath("Seller 2", "/stories/add")).toBe(true);
    });

    it("opens the reserve groups board for every role that can read orders", () => {
      for (const role of [
        "Seller 2",
        "Store Manager",
        "Store Manager 2",
        "Finance",
        "Founder",
        "Superadmin",
      ]) {
        expect(canRoleAccessPath(role, "/orders/reserve")).toBe(true);
        expect(canRoleAccessPath(role, "/orders/reserve/grp-1")).toBe(true);
      }
      expect(canRoleAccessPath("Seller 1", "/orders/reserve")).toBe(false);
      expect(canRoleAccessPath("Editor", "/orders/reserve")).toBe(false);
    });

    it("opens every homepage product surface to every role above Seller 1", () => {
      for (const role of [
        "Seller 2",
        "Store Manager",
        "Store Manager 2",
        "Finance",
        "Founder",
        "Superadmin",
      ]) {
        expect(canRoleAccessPath(role, "/products/homepage")).toBe(true);
        expect(canRoleAccessPath(role, "/products/gif-promo")).toBe(true);
        expect(canRoleAccessPath(role, "/products/homepage-custom-section")).toBe(true);
      }
      expect(canRoleAccessPath("Seller 1", "/products/homepage")).toBe(false);
      expect(canRoleAccessPath("Seller 1", "/products/gif-promo")).toBe(false);
      expect(canRoleAccessPath("Seller 1", "/products/homepage-custom-section")).toBe(false);
      expect(canRoleAccessPath("Editor", "/products/homepage")).toBe(false);
    });
  });

  describe("Finance", () => {
    it("inherits Seller 2 and receives financial reports and wallet administration without traffic", () => {
      for (const path of [
        "/products",
        "/products/categories",
        "/orders",
        "/sales",
        "/sales/products",
        "/sales/breakdown",
        "/sales/liquidity",
        "/wallets",
      ]) {
        expect(canRoleAccessPath("Finance", path)).toBe(true);
      }
      expect(canRoleAccessPath("Finance", "/stories")).toBe(true);
      for (const path of ["/sales/traffic", "/sales/funnel", "/orders/add"]) {
        expect(canRoleAccessPath("Finance", path)).toBe(false);
      }
    });
  });

  describe("Editor", () => {
    it("has a blog-and-stories admin workspace plus self-service account access", () => {
      expect(canRoleAccessPath("Editor", "/blog")).toBe(true);
      expect(canRoleAccessPath("Editor", "/blog/category-editorial")).toBe(
        true,
      );
      expect(canRoleAccessPath("Editor", "/account")).toBe(true);
      expect(canRoleAccessPath("Editor", "/products")).toBe(false);
      expect(canRoleAccessPath("Seller 1", "/blog/category-editorial")).toBe(
        false,
      );
      expect(canRoleAccessPath("Editor", "/orders")).toBe(false);
      expect(canRoleAccessPath("Editor", "/stories")).toBe(true);
      expect(canRoleAccessPath("Editor", "/stories/add")).toBe(true);
      expect(canRoleAccessPath("Editor", "/faq")).toBe(false);
      expect(canRoleAccessPath("Editor", "/sales")).toBe(false);
      expect(canRoleAccessPath("Editor", "/sales/activity")).toBe(false);
    });
  });

  describe("FAQ route", () => {
    it("points Superadmin at the site-faq editor instead of the legacy collection CRUD", () => {
      const faq = getSidebarItemsForRole("Superadmin").find(
        (item) => item.id === "faq",
      );
      expect(faq?.href).toBe("/faq");
      expect(faq?.children).toEqual([]);
      expect(canRoleAccessPath("Superadmin", "/faq")).toBe(true);
      expect(canRoleAccessPath("Superadmin", "/faq/categories")).toBe(true);
      expect(canRoleAccessPath("Founder", "/faq")).toBe(false);
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
      "Store Manager 2",
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
      expect(nav.map((item) => item.id)).toEqual(
        allowed.map((item) => item.id),
      );
    }
  });

  it("gives a Founder exactly the sales reports it may view", () => {
    expect(getSalesNavForRole("Founder").map((item) => item.href)).toEqual(
      FOUNDER_ALLOWED_SALES,
    );
  });

  it("gives a Store manager no sales analytics", () => {
    expect(
      getSalesNavForRole("Store manager").map((item) => item.href),
    ).toEqual([]);
  });

  it("gives Finance its reporting branch without Founder traffic", () => {
    expect(getSalesNavForRole("Finance").map((item) => item.href)).toEqual([
      "/sales",
      "/sales/products",
      "/sales/breakdown",
      "/sales/liquidity",
    ]);
  });

  it("shows the staff activity report only to Superadmin", () => {
    expect(getSalesNavForRole("Superadmin").map((item) => item.href)).toContain(
      "/sales/activity",
    );
    for (const role of [
      "Founder",
      "Finance",
      "Store Manager 2",
      "Store Manager",
      "Seller 2",
      "Seller 1",
      "Editor",
    ]) {
      expect(getSalesNavForRole(role).map((item) => item.href)).not.toContain(
        "/sales/activity",
      );
    }
  });
});

describe("Excel report route", () => {
  it("limits the export route and sidebar link to Superadmin", () => {
    expect(capabilitiesForRole("superadmin")).toContain("report.excel.export");
    expect(capabilitiesForRole("founder")).not.toContain("report.excel.export");
    expect(capabilitiesForRole("finance")).not.toContain("report.excel.export");
    expect(canRoleAccessPath("Superadmin", "/reports/exports")).toBe(true);
    expect(canRoleAccessPath("Founder", "/reports/exports")).toBe(false);
    expect(canRoleAccessPath("Finance", "/reports/exports")).toBe(false);
    expect(getSalesNavForRole("Superadmin").map((item) => item.href)).toContain("/reports/exports");
    expect(getSalesNavForRole("Founder").map((item) => item.href)).not.toContain("/reports/exports");
    expect(getSalesNavForRole("Finance").map((item) => item.href)).not.toContain("/reports/exports");
    for (const role of ["Founder", "Finance"]) {
      const sales = getSidebarItemsForRole(role).find((item) => item.id === "sales");
      expect(sales?.children.map((child) => child.href)).not.toContain("/reports/exports");
    }
    const superadminSales = getSidebarItemsForRole("Superadmin").find((item) => item.id === "sales");
    expect(superadminSales?.children.map((child) => child.href)).toContain("/reports/exports");
  });

  it("keeps legacy sales and finance reports accessible to Finance and Founder", () => {
    for (const role of ["Founder", "Finance"]) {
      for (const path of ["/sales", "/sales/products", "/sales/breakdown", "/sales/liquidity"]) {
        expect(canRoleAccessPath(role, path)).toBe(true);
      }
    }
  });
});

describe("sidebar", () => {
  const parentIds = (role: string | null) =>
    getSidebarItemsForRole(role).map((item) => item.id);

  it("shows stories to every staff role except Seller 1", () => {
    for (const role of [
      "Editor",
      "Seller 2",
      "Store Manager",
      "Store Manager 2",
      "Finance",
      "Founder",
      "Superadmin",
    ]) {
      expect(
        getSidebarItemsForRole(role).some(
          (item) =>
            item.id === "stories" ||
            item.id === "stories-list" ||
            item.href === "/stories" ||
            item.children.some((child) => child.href === "/stories"),
        ),
      ).toBe(true);
    }
    expect(
      getSidebarItemsForRole("Seller 1").some(
        (item) =>
          item.id === "stories" ||
          item.id === "stories-list" ||
          item.href === "/stories",
      ),
    ).toBe(false);
  });

  it("no longer exposes carts as a top-level destination", () => {
    // It lives inside the Orders/commerce surface now.
    expect(parentIds("Superadmin")).not.toContain("carts");
  });

  it("shows issue reports in the Superadmin and Support sidebars only", () => {
    for (const role of ADMIN_ROLE_IDS) {
      const items = parentIds(ADMIN_ROLE_DEFINITIONS[role].strapiName);
      if (role === "superadmin" || role === "support") {
        expect(items).toContain("issue-reports");
      } else {
        expect(items).not.toContain("issue-reports");
      }
    }
  });

  it("shows model applications to Founder and Superadmin only", () => {
    for (const role of ADMIN_ROLE_IDS) {
      const items = parentIds(ADMIN_ROLE_DEFINITIONS[role].strapiName);
      if (role === "superadmin" || role === "founder") {
        expect(items).toContain("model-applications");
      } else {
        expect(items).not.toContain("model-applications");
      }
    }
    expect(canRoleAccessPath("Seller 2", "/model-applications")).toBe(false);
    expect(canRoleAccessPath("Finance", "/model-applications")).toBe(false);
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

  it("keeps Store Manager off sales analytics destinations", () => {
    expect(parentIds("Store manager")).not.toContain("sales-products");
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

  it("groups activity with sales for Superadmin and removes it from settings", () => {
    const items = getSidebarItemsForRole("Superadmin");
    const sales = items.find((item) => item.id === "sales");
    const settings = items.find((item) => item.id === "settings");

    expect(sales?.children.map((child) => child.href)).toContain(
      "/sales/activity",
    );
    expect(settings?.children.map((child) => child.href)).not.toContain(
      "/settings/activity",
    );
  });

  it("keeps carts under the commerce orders surface", () => {
    const sales = getSidebarItemsForRole("Superadmin").find(
      (item) => item.id === "sales",
    );
    const hrefs = sales?.children.map((child) => child.href) ?? [];
    expect(hrefs).toContain("/sales/liquidity");
    expect(hrefs).not.toContain("/sales/carts");
    const orders = getSidebarItemsForRole("Superadmin").find(
      (item) => item.id === "orders",
    );
    expect(orders?.href).toBe("/orders");
    expect(orders?.children.map((child) => child.href)).toEqual([
      "/orders",
      "/orders/reserve",
      "/orders/carts",
    ]);
    expect(orders?.children.map((child) => child.id)).toEqual([
      "orders-main",
      "orders-reserve",
      "orders-carts",
    ]);
    expect(orders?.children[0]).toEqual(
      expect.objectContaining({
        id: "orders-main",
        label: "سفارشات",
        href: "/orders",
      }),
    );
    expect(orders?.children[1]).toEqual(
      expect.objectContaining({
        id: "orders-reserve",
        label: "سفارش‌های رزروی",
        href: "/orders/reserve",
      }),
    );
  });

  it("lets order-capable roles open سفارشات and سفارش‌های رزروی from the مدیریت سفارشات group", () => {
    for (const role of [
      "Seller 2",
      "Store Manager",
      "Store Manager 2",
      "Finance",
    ]) {
      const orders = getSidebarItemsForRole(role).find(
        (item) => item.id === "orders",
      );
      expect(orders?.label).toBe("مدیریت سفارشات");
      expect(orders?.href).toBe("/orders");
      expect(
        orders?.children.some(
          (child) => child.id === "orders-main" && child.href === "/orders",
        ),
      ).toBe(true);
      expect(
        orders?.children.some(
          (child) =>
            child.id === "orders-reserve" && child.href === "/orders/reserve",
        ),
      ).toBe(true);
    }
  });

  it("promotes Editor blog and stories children to icon-backed top-level destinations", () => {
    const items = getSidebarItemsForRole("Editor");
    expect(items.map((item) => item.id)).toEqual([
      "dashboard",
      "blog-dashboard",
      "blog-posts",
      "blog-category-editorial",
      "blog-categories",
      "blog-category-banners",
      "blog-tags",
      "blog-authors",
      "blog-comments",
      "stories-list",
      "stories-add",
    ]);
    expect(items.every((item) => item.icon && item.children.length === 0)).toBe(
      true,
    );
  });

  it("promotes focused catalog destinations for seller and Store Manager roles", () => {
    for (const role of [
      "Seller 1",
      "Seller 2",
      "Store Manager",
      "Store Manager 2",
    ]) {
      const items = getSidebarItemsForRole(role);
      expect(items.some((item) => item.id === "manage-products")).toBe(false);
      expect(items.some((item) => item.id === "products" && item.icon)).toBe(
        true,
      );
      expect(
        items.some((item) => item.id === "product-tags" && item.icon),
      ).toBe(true);
    }
  });

  it("keeps every role's top-level information architecture within a useful range", () => {
    const expectedCounts: Record<string, number> = {
      Editor: 11,
      "Seller 1": 3,
      "Seller 2": 9,
      "Store Manager": 9,
      "Store Manager 2": 10,
      Finance: 6,
      Founder: 7,
      Superadmin: 13,
    };

    for (const [role, count] of Object.entries(expectedCounts)) {
      expect(getSidebarItemsForRole(role)).toHaveLength(count);
    }
  });

  it("shows the individual catalog editors in the Superadmin sidebar only", () => {
    const catalogEditorPaths = [
      "/products/colors",
      "/products/attributes",
      "/products/size-guide",
    ];
    const linksTo = (role: string, href: string) =>
      getSidebarItemsForRole(role).some(
        (item) =>
          item.href === href ||
          item.children.some((child) => child.href === href),
      );

    for (const role of ADMIN_ROLE_IDS) {
      const strapiName = ADMIN_ROLE_DEFINITIONS[role].strapiName;
      for (const href of catalogEditorPaths) {
        expect(linksTo(strapiName, href)).toBe(role === "superadmin");
      }
    }
  });

  it("keeps the hidden catalog editors reachable for the roles that hold the capability", () => {
    // Hiding them trims the sidebar for support staff; it is not a permission
    // change, so a direct link must still open the page.
    for (const role of [
      "Seller 1",
      "Seller 2",
      "Store Manager",
      "Store Manager 2",
      "Finance",
      "Founder",
    ]) {
      expect(canRoleAccessPath(role, "/products/colors")).toBe(true);
      expect(canRoleAccessPath(role, "/products/attributes")).toBe(true);
      expect(canRoleAccessPath(role, "/products/size-guide")).toBe(true);
    }
  });

  it("adds wallets to Store Manager 2 without exposing user administration", () => {
    const items = getSidebarItemsForRole("Store Manager 2");
    expect(
      items.some((item) => item.id === "wallets" && item.href === "/wallets"),
    ).toBe(true);
    expect(items.some((item) => item.id === "users")).toBe(false);
    expect(items.some((item) => item.id === "sales")).toBe(false);
  });

  it("groups dense Superadmin commerce and customer controls", () => {
    const ids = parentIds("Superadmin");
    expect(ids).toContain("store-operations");
    expect(ids).toContain("customer-operations");
    expect(ids).not.toContain("payment-methods");
    expect(ids).not.toContain("wallets");
  });
});
