import { expect, type Page } from "@playwright/test";

const THIRD_PARTY_HOST_PATTERN =
  /(?:matomo|googletagmanager|google-analytics|sentry|clarity|facebook|doubleclick)/i;

function isThirdPartyRequest(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return false;
    }
    return THIRD_PARTY_HOST_PATTERN.test(hostname);
  } catch {
    return false;
  }
}

const IGNORED_RUNTIME_ERROR_PATTERN =
  /(?:Failed to load resource|net::ERR_ABORTED|net::ERR_BLOCKED_BY_CLIENT|favicon\.ico|ResizeObserver loop|_next\/webpack-hmr|WebSocket connection.*ERR_INVALID_HTTP_RESPONSE|A tree hydrated but some attributes)/i;

export type RuntimeErrorCollector = {
  errors: string[];
  assertClean: () => void;
};

export async function prepareStorefrontPage(page: Page): Promise<RuntimeErrorCollector> {
  const errors: string[] = [];

  await page.route((url) => isThirdPartyRequest(url), (route) => route.abort());

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
