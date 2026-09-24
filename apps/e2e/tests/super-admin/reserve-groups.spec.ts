import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { assertNonProductionTarget } from "../../helpers/admin";
import { apiPost, expectApiOk } from "../../helpers/api";
import { prepareStorefrontPage } from "../../helpers/page";

/**
 * Reserve shipments (48h combined shipping) as an admin operations surface.
 *
 * These tests deliberately do NOT create a reserve group through an API fixture.
 * The `reserve_groups` table has no CRUD routes on purpose -- it is only written
 * by checkout, payment settlement, early release and the expiry job -- so a
 * fixture would mean opening a write surface that exists solely for tests. What
 * is covered here is the contract everything else depends on: the group query
 * endpoint's shape, its segment filters, and the admin view being reachable.
 */
test.describe("super-admin reserve groups", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Reserve group operations coverage is desktop-only.",
    );
    assertNonProductionTarget();
  });

  test("@admin the reserve group query endpoint answers with the list contract", async ({
    request,
  }) => {
    const response = await apiPost(
      request,
      "admin",
      "/admin/orders-list/reserve-groups/query",
      { page: 1, pageSize: 10, tab: "all", sort: "deadline" },
    );
    await expectApiOk(response, "query reserve groups");

    const payload = (await response.json()) as {
      data?: unknown[];
      meta?: { pagination?: { page: number; pageSize: number; total: number } };
    };

    expect(Array.isArray(payload.data)).toBe(true);
    expect(payload.meta?.pagination).toMatchObject({ page: 1, pageSize: 10 });
    expect(typeof payload.meta?.pagination?.total).toBe("number");
  });

  test("@admin every lifecycle segment is a supported server-side filter", async ({
    request,
  }) => {
    // «رو به اتمام» is derived from the deadline, not a stored state, so it has
    // to be accepted by the server rather than filtered in the browser.
    for (const tab of ["active", "ending_soon", "ready", "fulfilling", "completed"]) {
      const response = await apiPost(
        request,
        "admin",
        "/admin/orders-list/reserve-groups/query",
        { page: 1, pageSize: 5, tab, sort: "deadline" },
      );
      await expectApiOk(response, `query reserve groups tab=${tab}`);
      const payload = (await response.json()) as { data?: unknown[] };
      expect(Array.isArray(payload.data), `tab ${tab} returns rows`).toBe(true);
    }
  });

  test("@admin an unsupported segment is rejected rather than silently ignored", async ({
    request,
  }) => {
    const response = await apiPost(
      request,
      "admin",
      "/admin/orders-list/reserve-groups/query",
      { page: 1, pageSize: 5, tab: "not-a-tab", sort: "deadline" },
    );
    expect(response.status()).toBe(400);
  });

  test("@admin the reserve sidebar child reaches the group operations view", async ({ page }) => {
    await prepareStorefrontPage(page);
    await page.goto("/orders", { waitUntil: "domcontentloaded" });

    const reserveLink = page.locator(
      '[data-testid="super-admin-sidebar-child"][data-sidebar-id="orders-reserve"]',
    );
    await expect(reserveLink).toBeVisible({ timeout: 30_000 });
    await reserveLink.click();

    await expect(page).toHaveURL(/\/orders\/reserve/, { timeout: 30_000 });
    // Segments render as real operations filters, not decoration.
    for (const label of ["فعال", "رو به اتمام", "آماده ارسال", "در حال ارسال", "تکمیل‌شده"]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }
  });
});
