import { expect, test, type Locator, type Page } from "@playwright/test";

const visiblePostLinkSelector = 'main article[data-variant] a[href^="/post/"]:visible';

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function firstVisibleCardForVariant(page: Page, variant: string) {
  const card = page.locator(`main article[data-variant="${variant}"]:visible`).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

async function expectMediaHitTarget(card: Locator) {
  const link = card.locator('a[href^="/post/"]').first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("Expected social post card link to have an href");
  expect(href).toMatch(/^\/post\/.+/);

  const hitTarget = await card.evaluate((article) => {
    const mediaLink = article.querySelector('a[href^="/post/"]');
    if (!mediaLink) return null;
    const rect = mediaLink.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    const closestLink = top?.closest("a");

    return {
      cursor: top ? getComputedStyle(top).cursor : null,
      href: mediaLink.getAttribute("href"),
      topClosestHref: closestLink?.getAttribute("href") ?? null,
      topTag: top?.tagName.toLowerCase() ?? null,
    };
  });

  expect(hitTarget).not.toBeNull();
  expect(hitTarget?.topClosestHref).toBe(href);
  expect(hitTarget?.cursor).toBe("pointer");

  return { href, link };
}

test.describe("social feed post card clickability", () => {
  test("@social feed cards expose clickable media links", async ({ page }) => {
    await page.goto("/");

    const postLinks = page.locator(visiblePostLinkSelector);
    const postCount = await postLinks.count();
    test.skip(
      postCount === 0,
      "Storefront homepage has no social post feed; run against the social app when feed coverage is required.",
    );
    await expect(postLinks.first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => postLinks.count()).toBeGreaterThanOrEqual(4);

    const variants = test.info().project.name.includes("mobile")
      ? ["mobile-sm", "mobile-lg"]
      : ["sm", "xl"];

    for (const variant of variants) {
      const card = await firstVisibleCardForVariant(page, variant);
      const { href, link } = await expectMediaHitTarget(card);

      await link.click();
      await expect(page).toHaveURL(new RegExp(`${escapeRegex(href)}$`));

      await page.goBack();
      await expect(page.locator(visiblePostLinkSelector).first()).toBeVisible({
        timeout: 30_000,
      });
    }
  });
});
