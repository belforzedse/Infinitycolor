import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  cleanupRuntimeProducts,
  createRuntimeProductFixture,
  updateRuntimeVariationStock,
} from "../../helpers/admin";
import { apiGet, apiPut, expectApiOk, getProductVariationStock } from "../../helpers/api";
import { prepareStorefrontPage } from "../../helpers/page";

test.describe("super-admin product CRUD", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Super-admin CRUD coverage is desktop-only.",
    );
    await cleanupRuntimeProducts(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupRuntimeProducts(request);
  });

  test("@admin super-admin can read, update, and soft-delete a runtime product", async ({
    page,
    request,
  }) => {
    await prepareStorefrontPage(page);
    const fixture = await createRuntimeProductFixture(request);

    await page.goto("/super-admin/products?pageSize=100", { waitUntil: "domcontentloaded" });
    const row = page
      .locator('[data-testid="admin-product-row"]:visible')
      .filter({ hasText: fixture.productTitle })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    await page
      .locator(`[data-testid="admin-product-edit"][data-id="${fixture.productId}"]:visible`)
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/super-admin/products/${fixture.productId}$`));

    const updatedTitle = `${fixture.productTitle} Updated`;
    const updateResponse = await apiPut(request, "admin", `/products/${fixture.productId}`, {
      data: { Title: updatedTitle },
    });
    await expectApiOk(updateResponse, "update runtime product");

    await page.goto("/super-admin/products?pageSize=100", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-testid="admin-product-row"]:visible').filter({ hasText: updatedTitle }).first(),
    ).toBeVisible({ timeout: 30_000 });

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
