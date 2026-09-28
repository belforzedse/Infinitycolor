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
