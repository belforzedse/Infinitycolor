import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  cleanupRuntimeProducts,
  createRuntimeProductFixture,
  expectForbiddenForRole,
} from "../../helpers/admin";
import { apiGet, apiPut, expectApiOk } from "../../helpers/api";

function sidebarParent(page: import("@playwright/test").Page, id: string) {
  return page.locator(
    `[data-testid="super-admin-sidebar-item"][data-sidebar-id="${id}"]`,
  );
}

function visibleSidebarParent(
  page: import("@playwright/test").Page,
  id: string,
) {
  return page
    .locator(
      `[data-testid="super-admin-sidebar-item"][data-sidebar-id="${id}"]:visible`,
    )
    .first();
}

test.describe("role permission enforcement", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Permission sidebar and direct-route coverage is desktop-only.",
    );
    await cleanupRuntimeProducts(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupRuntimeProducts(request);
  });

  test.describe("Founder", () => {
    test.use({ storageState: authStorageStatePath("founder") });

    test("@permissions Founder sees only allowed admin navigation and cannot use forbidden APIs", async ({
      page,
      request,
    }) => {
      const fixture = await createRuntimeProductFixture(request);

      await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
      await expect(visibleSidebarParent(page, "manage-products")).toBeVisible({
        timeout: 30_000,
      });
      await expect(sidebarParent(page, "users")).toHaveCount(0);
      await expect(sidebarParent(page, "customization")).toHaveCount(0);
      await expect(visibleSidebarParent(page, "reports")).toHaveAttribute(
        "data-sidebar-href",
        "/super-admin/reports/product-sales",
      );

      await page.goto("/super-admin/users", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/super-admin\/?$/, { timeout: 30_000 });

      await expectForbiddenForRole(
        request,
        "founder",
        "get",
        "/admin-activities",
      );
      await expectForbiddenForRole(
        request,
        "founder",
        "delete",
        `/products/${fixture.productId}`,
      );

      const salesReport = await apiGet(
        request,
        "founder",
        "/reports/product-sales",
      );
      await expectApiOk(salesReport, "Founder product-sales report");
    });
  });

  test.describe("Store manager", () => {
    test.use({ storageState: authStorageStatePath("store-manager") });

    test("@permissions Store manager can update products but cannot hard-delete or read admin activity", async ({
      page,
      request,
    }) => {
      const fixture = await createRuntimeProductFixture(request);

      await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
      await expect(visibleSidebarParent(page, "manage-products")).toBeVisible({
        timeout: 30_000,
      });
      await expect(sidebarParent(page, "users")).toHaveCount(0);
      await expect(sidebarParent(page, "reports")).toHaveCount(0);

      const updateResponse = await apiPut(
        request,
        "store-manager",
        `/products/${fixture.productId}`,
        {
          data: { Title: `${fixture.productTitle} Store Manager Update` },
        },
      );
      await expectApiOk(updateResponse, "Store manager product update");

      await expectForbiddenForRole(
        request,
        "store-manager",
        "delete",
        `/products/${fixture.productId}`,
      );
      await expectForbiddenForRole(
        request,
        "store-manager",
        "get",
        "/admin-activities",
      );
    });
  });

  test.describe("Editor", () => {
    test.use({ storageState: authStorageStatePath("editor") });

    test("@permissions Editor stays in the blog workspace and cannot mutate products", async ({
      page,
      request,
    }) => {
      const fixture = await createRuntimeProductFixture(request);

      await page.goto("/super-admin/products", {
        waitUntil: "domcontentloaded",
      });
      await expect(page).toHaveURL(/\/super-admin\/blog\/?$/, {
        timeout: 30_000,
      });
      await expect(sidebarParent(page, "manage-products")).toHaveCount(0);

      await expectForbiddenForRole(
        request,
        "editor",
        "put",
        `/products/${fixture.productId}`,
        {
          data: { Title: `${fixture.productTitle} Editor Update` },
        },
      );
    });
  });

  test.describe("Customer", () => {
    test.use({ storageState: authStorageStatePath("customer") });

    test("@permissions Customer cannot access the super-admin area or admin APIs", async ({
      page,
      request,
    }) => {
      const fixture = await createRuntimeProductFixture(request);

      await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/super-admin\/?$/, {
        timeout: 30_000,
      });

      await expectForbiddenForRole(
        request,
        "customer",
        "delete",
        `/products/${fixture.productId}`,
      );
      await expectForbiddenForRole(request, "customer", "get", "/users");
    });
  });

  test.describe("Superadmin", () => {
    test.use({ storageState: authStorageStatePath("admin") });

    test("@permissions Superadmin keeps full navigation and API access", async ({
      page,
      request,
    }) => {
      await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
      await expect(visibleSidebarParent(page, "manage-products")).toBeVisible({
        timeout: 30_000,
      });
      await expect(visibleSidebarParent(page, "users")).toBeVisible();
      await expect(visibleSidebarParent(page, "reports")).toBeVisible();

      const users = await apiGet(request, "admin", "/users");
      await expectApiOk(users, "Superadmin users list");
    });
  });
});
