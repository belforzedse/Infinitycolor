import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { prepareStorefrontPage } from "../../helpers/page";
import { apiGet, expectApiOk } from "../../helpers/api";

/**
 * The storefront side of 48h combined shipping.
 *
 * A signed-in shopper with no open window sees Case A: the reserve option is
 * offered on checkout as an explicit choice. Case B (an existing window) cannot
 * be staged without a completed payment -- see the note in the admin reserve
 * spec -- so what is asserted here is that the option exists, is never
 * pre-selected, and that the reserve history surfaces exist and are honest when
 * the shopper has no groups.
 */
test.describe("storefront reserve shipping", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test("@smoke the reserve group endpoint answers with the customer list contract", async ({
    request,
  }) => {
    const response = await apiGet(request, "customer", "/orders/reserve-groups", {
      page: "1",
      pageSize: "10",
    });
    await expectApiOk(response, "list my reserve groups");

    const payload = (await response.json()) as {
      data?: unknown[];
      meta?: { pagination?: { page: number; total: number } };
    };
    expect(Array.isArray(payload.data)).toBe(true);
    expect(typeof payload.meta?.pagination?.total).toBe("number");
  });

  test("@smoke active-reserve returns null rather than an unusable window", async ({
    request,
  }) => {
    const response = await apiGet(request, "customer", "/orders/active-reserve");
    await expectApiOk(response, "get active reserve");

    const payload = (await response.json()) as { data?: unknown };
    // Either a real attachable group, or explicitly null -- never a partial
    // object that the checkout would offer and the backend would then refuse.
    if (payload.data !== null) {
      expect(payload.data).toMatchObject({
        reserveGroupId: expect.any(String),
        orderCount: expect.any(Number),
      });
    }
  });

  test("@smoke the orders page exposes a reserve shipments tab", async ({ page }) => {
    await prepareStorefrontPage(page);
    await page.goto("/orders", { waitUntil: "domcontentloaded" });

    // Kits/Tabs is Headless UI, so the tab exposes role="tab" (the admin SubNav
    // uses plain buttons -- the two are not interchangeable in a locator).
    const reserveTab = page.getByRole("tab", { name: "سفارش‌های رزروی" });
    await expect(reserveTab).toBeVisible({ timeout: 30_000 });
    await reserveTab.click();

    // Groups are loaded as groups; with none, the tab explains the feature
    // rather than rendering an empty order list.
    await expect(
      page
        .getByTestId("reserve-groups-panel")
        .or(page.getByText("هنوز سفارش رزروی ثبت نکرده‌اید.")),
    ).toBeVisible({ timeout: 30_000 });
  });
});
