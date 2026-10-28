import { expect, type Page, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { cleanupRuntimeProducts, createRuntimeProductFixture } from "../../helpers/admin";
import { apiGet, expectApiOk } from "../../helpers/api";
import { strapiApiURL } from "../../helpers/env";
import { prepareStorefrontPage } from "../../helpers/page";

/**
 * Products lifecycle: a draft moves to Trash (and off the storefront), comes
 * back from Trash as a draft — never republished — and is permanently deleted
 * only from Trash, behind the typed confirmation.
 */

async function readProduct(request: Parameters<typeof apiGet>[0], productId: number) {
  const response = await apiGet(request, "admin", `/products/${productId}`);
  if (response.status() === 404) return null;
  await expectApiOk(response, "read runtime product");
  const payload = (await response.json()) as {
    data?: { attributes?: { removedAt?: string | null; Status?: string } };
  };
  return payload.data?.attributes ?? null;
}

async function openRowMenu(page: Page, productId: number) {
  await page
    .locator(`[data-testid="admin-product-actions"][data-id="${productId}"]:visible`)
    .first()
    .click();
}

function productRow(page: Page, title: string) {
  return page.locator('[data-testid="admin-product-row"]:visible').filter({ hasText: title }).first();
}

test.describe("super-admin product lifecycle", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Super-admin lifecycle coverage is desktop-only.",
    );
    await cleanupRuntimeProducts(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupRuntimeProducts(request);
  });

  test("@admin a product goes to Trash, comes back as a draft, and is deleted only from Trash", async ({
    page,
    request,
  }) => {
    await prepareStorefrontPage(page);
    const fixture = await createRuntimeProductFixture(request, { initialPublication: "Active" });

    // Published and public.
    const publicBefore = await request.get(
      `${strapiApiURL().replace(/\/$/, "")}/products/by-slug/${encodeURIComponent(fixture.productSlug)}`,
    );
    expect(publicBefore.status()).toBe(200);

    await page.goto(`/products?view=published&q=${encodeURIComponent(fixture.productTitle)}`, {
      waitUntil: "commit",
    });
    await expect(productRow(page, fixture.productTitle)).toBeVisible({ timeout: 30_000 });

    // Move to Trash: out of the storefront at once.
    await openRowMenu(page, fixture.productId);
    await page
      .locator(`[data-testid="admin-product-soft-delete"][data-id="${fixture.productId}"]:visible`)
      .first()
      .click();
    await expect(page.getByTestId("admin-product-undo-toast")).toBeVisible();
    await expect.poll(async () => (await readProduct(request, fixture.productId))?.removedAt ?? null).not.toBeNull();
    const publicAfterTrash = await request.get(
      `${strapiApiURL().replace(/\/$/, "")}/products/by-slug/${encodeURIComponent(fixture.productSlug)}`,
    );
    expect(publicAfterTrash.status()).toBe(404);

    // It is listed in Trash, with no Edit or publish action.
    await page.goto(`/products?view=trash&q=${encodeURIComponent(fixture.productTitle)}`, {
      waitUntil: "commit",
    });
    await expect(productRow(page, fixture.productTitle)).toBeVisible({ timeout: 30_000 });
    await openRowMenu(page, fixture.productId);
    await expect(
      page.locator(`[data-testid="admin-product-publish"][data-id="${fixture.productId}"]`),
    ).toHaveCount(0);

    // Restore lands on draft, not back on the storefront.
    await page
      .locator(`[data-testid="admin-product-restore"][data-id="${fixture.productId}"]:visible`)
      .first()
      .click();
    await expect
      .poll(async () => await readProduct(request, fixture.productId))
      .toEqual(expect.objectContaining({ removedAt: null, Status: "InActive" }));

    await page.goto(`/products?view=drafts&q=${encodeURIComponent(fixture.productTitle)}`, {
      waitUntil: "commit",
    });
    await expect(productRow(page, fixture.productTitle)).toBeVisible({ timeout: 30_000 });

    // Permanent deletion is only offered from Trash, behind the typed phrase.
    await openRowMenu(page, fixture.productId);
    await expect(
      page.locator(`[data-testid="admin-product-permanent-delete"][data-id="${fixture.productId}"]`),
    ).toHaveCount(0);
    await page
      .locator(`[data-testid="admin-product-soft-delete"][data-id="${fixture.productId}"]:visible`)
      .first()
      .click();
    await expect.poll(async () => (await readProduct(request, fixture.productId))?.removedAt ?? null).not.toBeNull();

    await page.goto(`/products?view=trash&q=${encodeURIComponent(fixture.productTitle)}`, {
      waitUntil: "commit",
    });
    await expect(productRow(page, fixture.productTitle)).toBeVisible({ timeout: 30_000 });
    await openRowMenu(page, fixture.productId);
    await page
      .locator(`[data-testid="admin-product-permanent-delete"][data-id="${fixture.productId}"]:visible`)
      .first()
      .click();
    const dialog = page.getByTestId("admin-product-permanent-delete-dialog");
    await expect(dialog).toBeVisible();
    const confirm = page.getByRole("button", { name: "حذف برای همیشه" });
    await expect(confirm).toBeDisabled();
    await page.getByLabel("عبارت تأیید حذف دائمی").fill("حذف دائمی");
    await confirm.click();

    await expect.poll(async () => await readProduct(request, fixture.productId)).toBeNull();
    await expect(productRow(page, fixture.productTitle)).toHaveCount(0);
  });
});
