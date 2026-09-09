import { expect, test, type Page } from "@playwright/test";
import {
  E2E_CATEGORY_SLUG,
  E2E_PRODUCT_SLUG,
  E2E_XXXL_PRODUCT_SLUG,
} from "../../fixtures/storefront";
import { prepareStorefrontPage } from "../../helpers/page";

const visibleResultCard = (slug: string) =>
  `[data-testid="plp-product-results"] [data-testid="product-card"][data-product-slug="${slug}"]:visible`;

const visibleTestId = (page: Page, testId: string) =>
  page.locator(`[data-testid="${testId}"]:visible`);

async function openFiltersIfNeeded(page: Page) {
  const openButton = visibleTestId(page, "plp-open-filters");
  if (await openButton.isVisible()) {
    await openButton.click();
  }
  await expect(visibleTestId(page, "plp-size-filter")).toBeVisible({
    timeout: 15_000,
  });
}

async function closeFiltersIfNeeded(page: Page) {
  const applyButton = page.getByRole("button", { name: "اعمال فیلتر ها" });
  if (await applyButton.isVisible()) {
    await applyButton.click();
  }
}

test.describe("PLP size and color filters", () => {
  test("@smoke size search maps 3xl onto XXXL aliases", async ({ page }) => {
    const runtime = await prepareStorefrontPage(page);
    await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}`);

    await expect(page.locator(visibleResultCard(E2E_PRODUCT_SLUG)).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator(visibleResultCard(E2E_XXXL_PRODUCT_SLUG)).first()).toBeVisible();

    await openFiltersIfNeeded(page);
    const sizeSearch = visibleTestId(page, "plp-size-search");
    await expect(sizeSearch).toBeVisible({ timeout: 15_000 });
    await sizeSearch.fill("3xl");
    const sizeOption = visibleTestId(page, "plp-size-option-3xl");
    await expect(sizeOption).toBeVisible();
    await sizeOption.click();
    await expect(page).toHaveURL(/size=3xl/);
    await closeFiltersIfNeeded(page);

    await expect(page.locator(visibleResultCard(E2E_PRODUCT_SLUG)).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator(visibleResultCard(E2E_XXXL_PRODUCT_SLUG)).first()).toBeVisible();

    await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}?size=2xs`);
    await expect(page.locator(visibleResultCard(E2E_PRODUCT_SLUG))).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(page.locator(visibleResultCard(E2E_XXXL_PRODUCT_SLUG))).toHaveCount(0);
    runtime.assertClean();
  });

  test("@smoke color family swatch filters blue aliases and persists", async ({
    page,
  }) => {
    const runtime = await prepareStorefrontPage(page);
    await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}`);
    await expect(page.locator(visibleResultCard(E2E_PRODUCT_SLUG)).first()).toBeVisible({
      timeout: 30_000,
    });

    await openFiltersIfNeeded(page);
    const blueOption = visibleTestId(page, "plp-color-option-blue");
    await expect(blueOption).toBeVisible({ timeout: 15_000 });
    const swatch = blueOption.locator('[data-testid="plp-color-swatch"]');
    await expect(swatch).toBeVisible();
    await expect(swatch).toHaveClass(/rounded-full/);
    const shades = (await swatch.getAttribute("data-shades"))?.split(",") ?? [];
    expect(shades).toHaveLength(4);
    const backgroundImage = await swatch.evaluate(
      (element) => getComputedStyle(element).backgroundImage,
    );
    expect(backgroundImage).toContain("conic-gradient");

    await blueOption.click();
    await expect(page).toHaveURL(/color=blue/);
    await closeFiltersIfNeeded(page);

    await expect(page.locator(visibleResultCard(E2E_PRODUCT_SLUG)).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.reload();
    await expect(page).toHaveURL(/color=blue/);
    await expect(page.locator(visibleResultCard(E2E_PRODUCT_SLUG)).first()).toBeVisible({
      timeout: 30_000,
    });
    runtime.assertClean();
  });
});
