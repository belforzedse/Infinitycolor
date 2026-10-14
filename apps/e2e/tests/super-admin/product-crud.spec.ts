import { expect, type Page, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  cleanupRuntimeProducts,
  createRuntimeProductFixture,
  leaveRuntimeProductEditor,
  updateRuntimeVariationStock,
} from "../../helpers/admin";
import { apiGet, expectApiOk, getProductVariationStock } from "../../helpers/api";
import { prepareStorefrontPage } from "../../helpers/page";

async function waitForProductsListURLToSettle(page: Page) {
  await expect
    .poll(() => new URL(page.url()).searchParams.has("totalSize"))
    .toBe(true);

  // The products list can still write query params after totalSize appears
  // (search debounce / nuqs). Wait until the URL stops changing so a soft
  // navigation to /products/:id is not cancelled by a late replaceState.
  let lastUrl = page.url();
  let stableSince = Date.now();
  await expect
    .poll(() => {
      const current = page.url();
      if (current !== lastUrl) {
        lastUrl = current;
        stableSince = Date.now();
      }
      return Date.now() - stableSince >= 700;
    }, { timeout: 15_000 })
    .toBe(true);
}

test.describe("super-admin product CRUD", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Super-admin CRUD coverage is desktop-only.",
    );
    await cleanupRuntimeProducts(request);
  });

  test.afterEach(async ({ page, request }) => {
    await leaveRuntimeProductEditor(page, request);
    await cleanupRuntimeProducts(request);
  });

  test("@smoke @admin super-admin can read, update, and soft-delete a runtime product", async ({
    page,
    request,
  }) => {
    await prepareStorefrontPage(page);
    const fixture = await createRuntimeProductFixture(request);

    await page.goto("/products?pageSize=100", { waitUntil: "commit" });
    const row = page
      .locator('[data-testid="admin-product-row"]:visible')
      .filter({ hasText: fixture.productTitle })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await waitForProductsListURLToSettle(page);

    const editLink = page
      .locator(`[data-testid="admin-product-edit"][data-id="${fixture.productId}"]:visible`)
      .first();
    const editURLPattern = new RegExp(`/products/${fixture.productId}$`);
    await expect(editLink).toHaveAttribute("href", `/products/${fixture.productId}`);
    await Promise.all([
      page.waitForURL(editURLPattern, { waitUntil: "commit", timeout: 30_000 }),
      editLink.click(),
    ]);
    await expect(page).toHaveURL(editURLPattern);

    const updatedTitle = `${fixture.productTitle} Updated`;
    await expect(page.getByTestId("admin-product-save")).toBeEnabled();
    await page.locator('input[name="name"]').fill(updatedTitle);
    await page.getByTestId("admin-product-save").click();
    await expect.poll(async () => {
      const response = await apiGet(request, "admin", `/products/${fixture.productId}`);
      await expectApiOk(response, "read updated runtime product");
      return (await response.json()).data.attributes.Title;
    }).toBe(updatedTitle);

    await leaveRuntimeProductEditor(page, request);
    await waitForProductsListURLToSettle(page);
    await expect(
      page.locator('[data-testid="admin-product-row"]:visible').filter({ hasText: updatedTitle }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // Move to Trash lives in the row's actions menu.
    await page
      .locator(`[data-testid="admin-product-actions"][data-id="${fixture.productId}"]:visible`)
      .first()
      .click();
    await page
      .locator(`[data-testid="admin-product-soft-delete"][data-id="${fixture.productId}"]:visible`)
      .first()
      .click();

    await expect
      .poll(async () => {
        const response = await apiGet(request, "admin", `/products/${fixture.productId}`);
        await expectApiOk(response, "read soft-deleted product");
        const payload = (await response.json()) as {
          data?: { attributes?: { removedAt?: string | null } };
        };
        return payload.data?.attributes?.removedAt ?? null;
      })
      .not.toBeNull();
  });

  test("@admin super-admin can update product variation stock for a runtime product", async ({
    request,
  }) => {
    const fixture = await createRuntimeProductFixture(request);

    await updateRuntimeVariationStock(request, fixture.stockId, 17);

    await expect
      .poll(() => getProductVariationStock(request, fixture.variationId))
      .toBe(17);
  });
});
