import { expect, test } from "@playwright/test";
import {
  cleanupRuntimeProducts,
  createRuntimeProductFixture,
} from "../../helpers/admin";
import { apiGet, apiPost, clearCart, expectApiOk } from "../../helpers/api";
import { E2E_CATEGORY_SLUG } from "../../fixtures/storefront";
import { prepareStorefrontPage } from "../../helpers/page";

async function readStatus(
  request: Parameters<typeof apiGet>[0],
  productId: number,
) {
  const response = await apiGet(request, "admin", `/products/${productId}`);
  await expectApiOk(response, `read scheduled product ${productId}`);
  const payload = (await response.json()) as {
    data?: { attributes?: { Status?: string }; Status?: string };
  };
  return payload.data?.attributes?.Status ?? payload.data?.Status;
}

test.describe("scheduled-publication storefront visibility", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupRuntimeProducts(request);
    await clearCart(request);
  });

  test.afterEach(async ({ request }) => {
    await clearCart(request);
    await cleanupRuntimeProducts(request);
  });

  test("@regression hides the product before its due instant and exposes it after worker publication", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const runtime = await prepareStorefrontPage(page);
    const fixture = await createRuntimeProductFixture(request, {
      initialPublication: "InActive",
    });
    const publishAt = new Date(Date.now() + 20_000).toISOString();
    const schedule = await apiPost(
      request,
      "admin",
      `/products/${fixture.productId}/publication`,
      { action: "schedule", publishAt, timezone: "Asia/Tehran" },
    );
    await expectApiOk(schedule, "schedule storefront runtime product");

    const hiddenPdp = await page.goto(`/pdp/${fixture.productSlug}`, {
      waitUntil: "domcontentloaded",
    });
    expect(hiddenPdp?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: /محصول پیدا نشد/ }),
    ).toBeVisible();

    await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.locator(
        `[data-testid="product-card"][data-product-slug="${fixture.productSlug}"]`,
      ),
    ).toHaveCount(0);

    const blockedCart = await apiPost(request, "customer", "/carts/add-item", {
      productVariationId: fixture.variationId,
      count: 1,
    });
    expect(blockedCart.status()).toBe(400);
    expect(await blockedCart.text()).toContain(
      "Product is currently unavailable",
    );

    await expect
      .poll(() => readStatus(request, fixture.productId), {
        timeout: 75_000,
        intervals: [500, 1_000],
      })
      .toBe("Active");

    await page.goto(`/pdp/${fixture.productSlug}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("pdp-hero")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: /محصول پیدا نشد/ }),
    ).toHaveCount(0);

    await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.locator(
        `[data-testid="product-card"][data-product-slug="${fixture.productSlug}"]:visible`,
      ),
    ).toBeVisible({ timeout: 30_000 });

    const allowedCart = await apiPost(request, "customer", "/carts/add-item", {
      productVariationId: fixture.variationId,
      count: 1,
    });
    await expectApiOk(
      allowedCart,
      "add automatically published product to cart",
    );
    runtime.assertClean();
  });
});
