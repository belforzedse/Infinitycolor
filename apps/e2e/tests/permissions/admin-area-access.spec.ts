import { expect, test, type Page } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { apiGet, expectApiForbidden, expectApiOk } from "../../helpers/api";

/**
 * Per-area access matrix for the admin domains not covered by the product-focused
 * role-access spec: shipping, discounts (coupons) and users. Assertions are
 * grounded in the role sources of truth — getSidebarItemsForRole
 * (constants/superAdminSidebar) and FOUNDER_FORBIDDEN_PREFIXES
 * (constants/roleAccess) — plus the backend checks already proven elsewhere
 * (customer cannot read /users; founder can read the sales report).
 *
 * Matrix (sidebar parent visibility):
 *   area        | superadmin | founder | store-manager | editor
 *   shipping    |    yes     |  yes    |     no         |  no
 *   discounts   |    yes     |  no*    |     yes        |  no
 *   users       |    yes     |  no*    |     no         |  no
 *   reports     |    yes     |  sales  |     no         |  no
 *   (* founder is also hard route-guarded away from /coupons and /users)
 */

function sidebarParent(page: Page, id: string) {
  return page.locator(`[data-testid="super-admin-sidebar-item"][data-sidebar-id="${id}"]`);
}

function visibleSidebarParent(page: Page, id: string) {
  return page
    .locator(`[data-testid="super-admin-sidebar-item"][data-sidebar-id="${id}"]:visible`)
    .first();
}

test.describe("admin area access matrix (shipping / discounts / users)", () => {
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Admin navigation matrix is desktop-only.",
    );
  });

  test.describe("Superadmin", () => {
    test.use({ storageState: authStorageStatePath("admin") });

    test("@permissions @admin superadmin sees every managed area and can read users", async ({
      page,
      request,
    }) => {
      await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
      await expect(visibleSidebarParent(page, "shipping")).toBeVisible({ timeout: 30_000 });
      await expect(visibleSidebarParent(page, "discounts")).toBeVisible();
      await expect(visibleSidebarParent(page, "users")).toBeVisible();
      await expect(visibleSidebarParent(page, "reports")).toBeVisible();

      await expectApiOk(await apiGet(request, "admin", "/users"), "superadmin users list");
    });
  });

  test.describe("Founder", () => {
    test.use({ storageState: authStorageStatePath("founder") });

    test("@permissions founder keeps shipping + sales reports but is blocked from discounts and users", async ({
      page,
      request,
    }) => {
      await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
      await expect(visibleSidebarParent(page, "shipping")).toBeVisible({ timeout: 30_000 });
      await expect(sidebarParent(page, "discounts")).toHaveCount(0);
      await expect(sidebarParent(page, "users")).toHaveCount(0);
      await expect(visibleSidebarParent(page, "reports")).toHaveAttribute(
        "data-sidebar-href",
        "/super-admin/reports/product-sales",
      );

      // Direct-URL navigation to forbidden areas is bounced back to the dashboard.
      await page.goto("/super-admin/coupons", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/super-admin\/?$/, { timeout: 30_000 });
      await page.goto("/super-admin/users", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/super-admin\/?$/, { timeout: 30_000 });

      await expectApiOk(
        await apiGet(request, "founder", "/reports/product-sales"),
        "founder product-sales report",
      );
    });
  });

  test.describe("Store manager", () => {
    test.use({ storageState: authStorageStatePath("store-manager") });

    test("@permissions store manager sees discounts but not shipping, users or reports", async ({
      page,
    }) => {
      await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
      await expect(visibleSidebarParent(page, "discounts")).toBeVisible({ timeout: 30_000 });
      await expect(sidebarParent(page, "shipping")).toHaveCount(0);
      await expect(sidebarParent(page, "users")).toHaveCount(0);
      await expect(sidebarParent(page, "reports")).toHaveCount(0);
    });
  });

  test.describe("Editor", () => {
    test.use({ storageState: authStorageStatePath("editor") });

    test("@permissions editor sees only blog navigation, none of shipping/discounts/users", async ({
      page,
    }) => {
      await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
      await expect(visibleSidebarParent(page, "blog-posts")).toBeVisible({ timeout: 30_000 });
      await expect(sidebarParent(page, "shipping")).toHaveCount(0);
      await expect(sidebarParent(page, "discounts")).toHaveCount(0);
      await expect(sidebarParent(page, "users")).toHaveCount(0);
    });
  });

  test.describe("Customer", () => {
    test.use({ storageState: authStorageStatePath("customer") });

    test("@permissions customer cannot enter the super-admin area or read users", async ({
      page,
      request,
    }) => {
      await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/super-admin\/?$/, { timeout: 30_000 });

      await expectApiForbidden(await apiGet(request, "customer", "/users"));
    });
  });
});
