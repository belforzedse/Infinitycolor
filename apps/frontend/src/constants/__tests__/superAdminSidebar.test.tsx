import superAdminSidebar, { getSidebarItemsForRole } from "@/constants/superAdminSidebar";
import { FOUNDER_HIDDEN_PARENT_IDS } from "@/constants/roleAccess";

describe("getSidebarItemsForRole - Founder", () => {
  const founderItems = getSidebarItemsForRole("Founder");
  const founderIds = founderItems.map((i) => i.id);

  it("hides the restricted parent sections", () => {
    for (const hidden of FOUNDER_HIDDEN_PARENT_IDS) {
      expect(founderIds).not.toContain(hidden);
    }
  });

  it("keeps operational sections and hides raw customer/payment data", () => {
    expect(founderIds).toEqual(
      expect.arrayContaining(["dashboard", "orders", "manage-products", "discounts", "shipping"]),
    );
    expect(founderIds).not.toContain("carts");
    expect(founderIds).not.toContain("payment-methods");
    const shippingChildren = founderItems.find((item) => item.id === "shipping")?.children;
    expect(shippingChildren?.map((child) => child.id)).toEqual(["shipping-main"]);
  });

  it("does not expose stories", () => {
    expect(founderIds).not.toContain("stories");
  });

  it("exposes a single sales-report item labelled «گزارشات فروش» pointing to product-sales", () => {
    const reports = founderItems.filter((i) => i.id === "reports");
    expect(reports).toHaveLength(1);
    expect(reports[0].label).toBe("گزارشات فروش");
    expect(reports[0].href).toBe("/super-admin/reports/product-sales");
    expect(reports[0].children).toHaveLength(0);
  });

  it("does NOT expose traffic or admin-activity reports anywhere", () => {
    const allHrefs = founderItems.flatMap((i) => [i.href ?? "", ...i.children.map((c) => c.href)]);
    expect(allHrefs).not.toContain("/super-admin/reports/traffic");
    expect(allHrefs).not.toContain("/super-admin/reports/admin-activity");
  });
});

describe("getSidebarItemsForRole - Store manager", () => {
  const storeManagerItems = getSidebarItemsForRole("Store manager");
  const storeManagerIds = storeManagerItems.map((i) => i.id);

  it("hides stories and FAQ", () => {
    expect(storeManagerIds).not.toContain("stories");
    expect(storeManagerIds).not.toContain("faq");
  });

  it("shows the operational commerce sections and safe product tools", () => {
    expect(storeManagerIds).toEqual(
      expect.arrayContaining(["manage-products", "orders", "discounts", "shipping"]),
    );
    expect(storeManagerIds).not.toContain("payment-methods");
    expect(storeManagerIds).not.toContain("carts");
    const productChildren = storeManagerItems.find(
      (item) => item.id === "manage-products",
    )?.children;
    expect(productChildren?.map((child) => child.id)).toEqual(
      expect.arrayContaining([
        "product-attributes",
        "product-tags",
        "product-comments",
        "product-categories",
      ]),
    );
    const shippingChildren = storeManagerItems.find((item) => item.id === "shipping")?.children;
    expect(shippingChildren?.map((child) => child.id)).toEqual(["shipping-main"]);
  });
});

describe("getSidebarItemsForRole - Superadmin regression", () => {
  it("returns the full sidebar unchanged", () => {
    const items = getSidebarItemsForRole("Superadmin");
    expect(items).toBe(superAdminSidebar);
    const ids = items.map((i) => i.id);
    // Restricted sections remain visible for superadmins.
    expect(ids).toEqual(
      expect.arrayContaining(["customization", "blog", "faq", "discounts", "users", "settings"]),
    );
  });

  it("nests سفارشات under مدیریت سفارشات at the same href", () => {
    const orders = getSidebarItemsForRole("Superadmin").find(
      (item) => item.id === "orders",
    );
    expect(orders?.label).toBe("مدیریت سفارشات");
    expect(orders?.href).toBe("/super-admin/orders");
    expect(orders?.children[0]).toEqual(
      expect.objectContaining({
        id: "orders-main",
        label: "سفارشات",
        href: "/super-admin/orders",
      }),
    );
  });

  it("keeps the full reports submenu (traffic, product-sales, admin-activity) for superadmins", () => {
    const items = getSidebarItemsForRole("Superadmin");
    const reports = items.find((i) => i.id === "reports");
    const childHrefs = reports?.children.map((c) => c.href) ?? [];
    expect(childHrefs).toEqual(
      expect.arrayContaining([
        "/super-admin/reports/traffic",
        "/super-admin/reports/product-sales",
        "/super-admin/reports/admin-activity",
      ]),
    );
  });
});
