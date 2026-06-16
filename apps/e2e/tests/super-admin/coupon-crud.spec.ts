import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  assertNonProductionTarget,
  cleanupRuntimeCoupons,
  createRuntimeCoupon,
} from "../../helpers/admin";
import { apiGet, expectApiOk } from "../../helpers/api";
import { prepareStorefrontPage } from "../../helpers/page";

/**
 * Coupon management. The create form is a config-driven UpsertPage with Persian
 * date/dropdown widgets, so the coupon is seeded via the API fixture and the test
 * exercises the real list rendering, the edit-page route, and the list soft-delete
 * — the parts most prone to silent breakage — verifying state against the backend.
 * (A full UI-driven create is tracked as a follow-up once the UpsertPage field
 * renderer is mapped to stable locators.)
 */
test.describe("super-admin coupon CRUD", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Super-admin CRUD coverage is desktop-only.",
    );
    assertNonProductionTarget();
    await cleanupRuntimeCoupons(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupRuntimeCoupons(request);
  });

  test("@admin super-admin sees a coupon in the list, opens its edit page, and soft-deletes it", async ({
    page,
    request,
  }) => {
    await prepareStorefrontPage(page);
    const coupon = await createRuntimeCoupon(request, { type: "Discount", amount: 15 });

    // Row renders in the management list.
    await page.goto("/super-admin/coupons", { waitUntil: "domcontentloaded" });
    const row = page
      .locator(`[data-testid="admin-coupon-row"][data-id="${coupon.couponId}"]:visible`)
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveText(new RegExp(coupon.code, "i"));

    // Edit page loads for that coupon.
    await page
      .locator(`[data-testid="admin-coupon-edit"][data-id="${coupon.couponId}"]:visible`)
      .first()
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/super-admin/coupons/edit/${coupon.couponId}$`),
      { timeout: 30_000 },
    );

    // Soft-delete from the list, then verify backend state.
    await page.goto("/super-admin/coupons", { waitUntil: "domcontentloaded" });
    await page
      .locator(`[data-testid="admin-coupon-soft-delete"][data-id="${coupon.couponId}"]:visible`)
      .first()
      .click();

    await expect
      .poll(async () => {
        const response = await apiGet(request, "admin", `/discounts/${coupon.couponId}`);
        await expectApiOk(response, "read soft-deleted coupon");
        const payload = (await response.json()) as {
          data?: { attributes?: { removedAt?: string | null } };
        };
        return payload.data?.attributes?.removedAt ?? null;
      })
      .not.toBeNull();
  });
});
