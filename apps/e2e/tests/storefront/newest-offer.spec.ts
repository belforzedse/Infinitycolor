import { expect, test } from "@playwright/test";
import { E2E_PRODUCT_SLUG } from "../../fixtures/storefront";
import { cacheBustingSearchParam, strapiApiURL } from "../../helpers/env";
import { prepareStorefrontPage } from "../../helpers/page";

const NEWEST_PATH = "/offer?type=newest";
const resultCards = '[data-testid="plp-product-results"] [data-testid="product-card"]:visible';

test.describe("Newest listing (/offer?type=newest)", () => {
  test("@smoke homepage newest rail links its view-all to the Newest listing", async ({ page }) => {
    const runtime = await prepareStorefrontPage(page);
    await page.goto("/");

    const rail = page.locator('[data-home-full-bleed="newest"]');
    await expect(rail).toBeVisible({ timeout: 30_000 });
    const viewAll = rail.getByRole("link", { name: "مشاهده همه" }).filter({ visible: true }).first();
    await expect(viewAll).toHaveAttribute("href", NEWEST_PATH);

    await viewAll.click();
    await expect(page).toHaveURL(/\/offer\?type=newest$/);
    await expect(page.locator(resultCards).first()).toBeVisible({ timeout: 30_000 });
    runtime.assertClean();
  });

  test("@smoke renders the normal PLP on direct load and on reload", async ({ page }) => {
    const runtime = await prepareStorefrontPage(page);
    const response = await page.goto(NEWEST_PATH);
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1, name: "جدیدترین محصولات" })).toBeVisible();
    await expect(page.locator("[data-plp-top]")).toBeVisible();
    const seeded = page.locator(`${resultCards}[data-product-slug="${E2E_PRODUCT_SLUG}"]`).first();
    await expect(seeded).toBeVisible({ timeout: 30_000 });
    // Cards still open their own PDP.
    await expect(page.locator(`${resultCards} a[href^="/pdp/"]`).first()).toBeAttached();

    await page.reload();
    await expect(seeded).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/offer\?type=newest$/);
    runtime.assertClean();
  });

  test("answers an unknown offer type with the not-found page, never a listing", async ({ page }) => {
    // Streams under PPR like an unknown category, so the status can stay 200; what must
    // hold is that nothing is listed and crawlers are told not to index it.
    await page.goto("/offer?type=unknown");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator(resultCards)).toHaveCount(0);
  });

  test("redirects the old site's /offer/newest to the Newest listing", async ({ page }) => {
    await page.goto("/offer/newest/");
    await expect(page).toHaveURL(/\/offer\?type=newest$/);
  });

  test("@api the card query serves the Newest listing with a count", async ({ request }) => {
    const url = new URL(`${strapiApiURL()}/products`);
    url.searchParams.set("view", "card");
    url.searchParams.set("offer", "newest");
    url.searchParams.set("pagination[page]", "1");
    url.searchParams.set("pagination[pageSize]", "100");
    const { key, value } = cacheBustingSearchParam();
    url.searchParams.set(key, value);

    const response = await request.get(url.toString());
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    const slugs = (payload?.data ?? []).map(
      (card: { attributes?: { Slug?: string } }) => card.attributes?.Slug,
    );
    expect(slugs).toContain(E2E_PRODUCT_SLUG);
    expect(payload?.meta?.pagination?.total).toBeGreaterThanOrEqual(slugs.length);
  });
});
