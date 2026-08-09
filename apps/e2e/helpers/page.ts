import { expect, type Page } from "@playwright/test";
import { installLocalMediaFixture } from "./local-media";

const THIRD_PARTY_HOST_PATTERN =
  /(?:matomo|googletagmanager|google-analytics|sentry|clarity|facebook|doubleclick)/i;
const THIRD_PARTY_ROUTE_PATTERN =
  /^https?:\/\/[^/?#]*(?:matomo|googletagmanager|google-analytics|sentry|clarity|facebook|doubleclick)[^/?#]*(?:[/?#]|$)/i;

const IGNORED_RUNTIME_ERROR_PATTERN =
  /(?:Failed to load resource|net::ERR_ABORTED|net::ERR_BLOCKED_BY_CLIENT|favicon\.ico|ResizeObserver loop|_next\/webpack-hmr|WebSocket connection.*ERR_INVALID_HTTP_RESPONSE|A tree hydrated but some attributes)/i;

export type RuntimeErrorCollector = {
  errors: string[];
  assertClean: () => void;
};

export async function prepareStorefrontPage(page: Page): Promise<RuntimeErrorCollector> {
  const errors: string[] = [];

  await installLocalMediaFixture(page);
  // A URL predicate is implemented by Playwright as a catch-all interceptor
  // followed by client-side filtering. WebKit can surface harmless same-origin
  // prefetch cancellations as access-control page errors under that catch-all.
  // Register a browser-side URL pattern so local application requests are
  // never intercepted in the first place.
  await page.route(THIRD_PARTY_ROUTE_PATTERN, (route) => route.abort());

  await page.addInitScript(() => {
    window.localStorage.setItem("analytics-consent", "denied");
    window.localStorage.setItem("pdp_debug", "0");
  });

  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (THIRD_PARTY_HOST_PATTERN.test(text)) return;
    errors.push(`console.error: ${text}`);
  });

  return {
    errors,
    assertClean: () => {
      const critical = errors.filter((error) => !IGNORED_RUNTIME_ERROR_PATTERN.test(error));
      expect(critical).toEqual([]);
    },
  };
}

export async function expectImageLoaded(locator: ReturnType<Page["locator"]>) {
  await expect(locator).toBeVisible();
  await expect
    .poll(
      async () =>
        locator.evaluate((image) => {
          const img = image as HTMLImageElement;
          return {
            complete: img.complete,
            loaded: img.naturalWidth > 0 && img.naturalHeight > 0,
          };
        }),
      { timeout: 10_000 },
    )
    .toMatchObject({ complete: true, loaded: true });

  const size = await locator.evaluate((image) => {
    const img = image as HTMLImageElement;
    return { width: img.naturalWidth, height: img.naturalHeight };
  });
  expect(size.width).toBeGreaterThan(0);
  expect(size.height).toBeGreaterThan(0);
}
