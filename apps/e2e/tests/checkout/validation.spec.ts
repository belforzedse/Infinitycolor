import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { prepareStorefrontPage } from "../../helpers/page";
import { selectSeededAddress } from "../../helpers/checkout";

test.describe("authenticated checkout validation", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test.beforeEach(({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Checkout validation is exercised on desktop; mobile checkout has a separate layout.",
    );
  });

  test("@regression submitting an empty checkout surfaces a validation error and creates no order", async ({
    page,
  }) => {
    const runtime = await prepareStorefrontPage(page);

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("checkout-auth-gate")).toHaveCount(0);
    await expect(page.getByTestId("checkout-submit")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("checkout-submit").click();

    const error = page.getByTestId("checkout-form-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveText(/\S+/);
    await expect(page).toHaveURL(/\/checkout/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pendingOrderId"))).toBeNull();

    runtime.assertClean();
  });

  test("@regression choosing an address without a shipping method is rejected", async ({ page }) => {
    const runtime = await prepareStorefrontPage(page);

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("checkout-submit")).toBeVisible({ timeout: 30_000 });

    await selectSeededAddress(page);
    // Intentionally skip shipping selection.
    await page.getByTestId("checkout-submit").click();

    const error = page.getByTestId("checkout-form-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("ارسال");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pendingOrderId"))).toBeNull();

    runtime.assertClean();
  });
});
