import type { Page } from "@playwright/test";
import {
  expect,
  gotoStorefront,
  openFixtureCategory,
  productCardLink,
  stagingTargets,
  test,
} from "../../fixtures/staging";

/** First-party responses that answered 5xx while the page loaded. */
function recordServerErrors(page: Page) {
  const firstPartyHosts = new Set(Object.values(stagingTargets()).map((origin) => new URL(origin).host));
  const errors: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (firstPartyHosts.has(url.host) && response.status() >= 500) {
      errors.push(`${response.status()} ${url.pathname}`);
    }
  });
  return errors;
}

// Each page is checked on its own and left only after it is ready: leaving a
// page mid-load cancels its lazy chunks, which WebKit reports as uncaught.

test("the home page renders products without server or script errors", { tag: "@critical" }, async ({
  page,
  pageErrors,
}) => {
  const serverErrors = recordServerErrors(page);
  await gotoStorefront(page, "/");
  await expect(page.getByTestId("product-card").first()).toBeVisible();

  expect(serverErrors, "first-party requests answered 5xx").toEqual([]);
  expect(pageErrors, "uncaught errors on the page").toEqual([]);
});

test("a category listing shows its product without server or script errors", { tag: "@critical" }, async ({
  page,
  shopper,
  pageErrors,
}) => {
  const serverErrors = recordServerErrors(page);
  await openFixtureCategory(page, shopper);
  await expect(productCardLink(page, shopper)).toBeVisible();

  expect(serverErrors, "first-party requests answered 5xx").toEqual([]);
  expect(pageErrors, "uncaught errors on the page").toEqual([]);
});

// A card the server rendered must stay the same element through hydration: if
// React swaps it for a loading placeholder, a shopper's tap in that window hits
// the placeholder and does nothing (2 of 8 listing cards did, until 09-28).
test(
  "the listing keeps the product cards the server rendered, so an early tap is never lost",
  { tag: "@regression" },
  async ({ page, shopper }) => {
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        (window as unknown as { __serverCardLinks: Element[] }).__serverCardLinks = [
          ...document.querySelectorAll('[data-testid="plp-product-results"] [data-testid="product-card-link"]'),
        ];
      });
    });
    await openFixtureCategory(page, shopper);
    await expect(productCardLink(page, shopper)).toBeVisible();
    await expect(page.getByTestId("plp-product-results").locator(".skeleton-shimmer")).toHaveCount(0);
    await page.waitForLoadState("load");

    const { sent, kept } = await page.evaluate(() => {
      const links = (window as unknown as { __serverCardLinks?: Element[] }).__serverCardLinks ?? [];
      return { sent: links.length, kept: links.filter((link) => link.isConnected).length };
    });
    expect(sent, "card links in the server HTML").toBeGreaterThan(0);
    expect(kept, "server-rendered card links React replaced after hydration").toBe(sent);
  },
);
