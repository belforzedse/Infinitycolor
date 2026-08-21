import { expect, test } from "@playwright/test";
import { instant } from "@next/playwright";

test.describe("Next.js instant navigation", () => {
  test("storefront app shell covers catalog and blog without full homepage prefetches", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "storefront-instant");
    await page.goto("/");

    const catalog = page.locator('a[href^="/plp"]:visible').first();
    await expect(catalog).toBeVisible();
    await instant(page, async () => {
      await catalog.click();
      await expect(page.locator("header").first()).toBeVisible();
    });
    await expect(page).toHaveURL(/\/plp/);

    const category = page.locator('a[href^="/plp/category/"]:visible').first();
    if (await category.isVisible().catch(() => false)) {
      // Params-dependent category content is intentionally fetched after the click.
      // The homepage only warms the shared app shell.
      await category.click();
      await expect(page).toHaveURL(/\/plp\/category\//);
      await expect(page.locator("header").first()).toBeVisible();
    }

    const product = page
      .locator('[data-testid="product-card-link"]:visible')
      .first();
    if (await product.isVisible().catch(() => false)) {
      // PDP data is high-cardinality and may contain price/availability, so it is
      // never fully prefetched from a listing or the homepage.
      await product.click();
      await expect(page).toHaveURL(/\/pdp\//);
      await expect(page.locator("header").first()).toBeVisible();
    }

    await page.goto("/");
    const blog = page.locator('a[href="/blog"]:visible').first();
    if (await blog.isVisible().catch(() => false)) {
      await instant(page, async () => {
        await blog.click();
        await expect(page.locator("header").first()).toBeVisible();
      });
      await expect(page).toHaveURL(/\/blog/);
    }
  });

  test("social feed keeps post data out of prefetch while profile stays private", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "social-instant");
    await page.goto("/");

    const profile = page
      .locator('a[href="/profile"]:visible, a[href="/profile/bookmarks"]:visible')
      .first();
    await expect(profile).toHaveAttribute("href", /\/profile/);

    const post = page.locator('a[href^="/post/"]:visible').first();
    await expect(post).toBeVisible();
    // Dynamic post data is fetched only after activation; only the shared social
    // shell is eligible for automatic partial prefetching.
    await post.click();
    await expect(page).toHaveURL(/\/post\//, { timeout: 15_000 });
    await expect(page.locator("header").first()).toBeVisible();
  });
});
