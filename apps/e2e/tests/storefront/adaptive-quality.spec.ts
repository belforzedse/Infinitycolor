import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Request } from "@playwright/test";
import {
  E2E_CATEGORY_SLUG,
  E2E_PRODUCT_SLUG,
  E2E_PRODUCT_TITLE,
} from "../../fixtures/storefront";
import { authStorageStatePath } from "../../helpers/auth";
import {
  findProductVariationBySku,
  resetCartToVariation,
} from "../../helpers/api";
import {
  selectFirstShipping,
  selectSeededAddress,
} from "../../helpers/checkout";
import {
  finalizeToZarinpalRedirect,
  stubSuccessfulCallback,
} from "../../helpers/payment";
import { installLocalMediaFixture } from "../../helpers/local-media";
import { isExpectedHarnessConsoleError } from "../../helpers/runtime-console";

type AdaptivePreset = {
  memory?: number;
  cores?: number;
  saveData?: boolean;
  effectiveType?: string;
  reducedMotion?: boolean;
  reducedTransparency?: boolean;
  blockSessionStorage?: boolean;
  userAgent?: string;
  userAgentModel?: string;
  quietPerformanceObserver?: boolean;
};

type AdaptiveSnapshot = {
  enabled: boolean;
  rendering: "safe" | "standard" | "enhanced";
  media: "economy" | "standard" | "high";
  motion: "minimal" | "standard" | "enhanced";
  reducedTransparency: boolean;
  reason: string;
  routeGeneration: number;
};

declare global {
  interface Window {
    __INFINITY_AQ_E2E__?: {
      downgrade: (reason?: string) => void;
      setTier: (constraint: {
        rendering: AdaptiveSnapshot["rendering"];
        media: AdaptiveSnapshot["media"];
        motion: AdaptiveSnapshot["motion"];
      }) => void;
      startObservationWindow: (durationMs?: number) => void;
      completeObservationWindow: () => void;
      route: () => void;
      snapshot: () => AdaptiveSnapshot;
    };
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const frontendStaticDir = path.resolve(
  currentDir,
  "../../../frontend/.next/static",
);

const forbiddenChunkMarkers = [
  { family: "hero-motion", markers: ["hero-motion", "data-aq-hero"] },
  {
    family: "dotlottie",
    markers: ["DotLottieWorkerReact", "setWasmUrl"],
  },
  {
    family: "quick-view",
    markers: ["quick-view-content", "quick-view-full-details"],
  },
  { family: "share", markers: ["react-share", "اشتراک‌گذاری محصول"] },
  { family: "glass-surface", markers: ["glass-filter-", "distortionScale"] },
] as const;

// WebKit reports requests abandoned by a localhost page transition as page
// errors. The commerce assertions below still fail on a real data or routing
// regression; suppress only this engine-specific local harness diagnostic.
const localWebkitNavigationAccessControlError =
  /^\/(?:127\.0\.0\.1|localhost):\d+\/.* due to access control checks\.$/;

function collectStrictRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    if (
      page.context().browser()?.browserType().name() === "webkit" &&
      localWebkitNavigationAccessControlError.test(error.message)
    ) {
      return;
    }
    errors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (isExpectedHarnessConsoleError(message)) return;

    const text = message.text();
    const location = message.location().url;
    errors.push(
      `console.error: ${text}${location ? ` (${location})` : ""}`,
    );
  });
  return {
    errors,
    assertClean() {
      expect(
        errors,
        `Unexpected browser errors:\n${errors.join("\n")}`,
      ).toEqual([]);
    },
  };
}

async function installAdaptiveCapabilities(page: Page, preset: AdaptivePreset) {
  await page.addInitScript((options: AdaptivePreset) => {
    window.localStorage.setItem("analytics-consent", "denied");
    window.localStorage.setItem("pdp_debug", "0");

    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const forced =
        query === "(prefers-reduced-motion: reduce)"
          ? options.reducedMotion
          : query === "(prefers-reduced-transparency: reduce)"
            ? options.reducedTransparency
            : undefined;
      if (forced === undefined) return originalMatchMedia(query);

      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      return {
        matches: forced,
        media: query,
        onchange: null,
        addEventListener: (
          _type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          if (typeof listener === "function") {
            listeners.add(listener as (event: MediaQueryListEvent) => void);
          }
        },
        removeEventListener: (
          _type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          if (typeof listener === "function") {
            listeners.delete(listener as (event: MediaQueryListEvent) => void);
          }
        },
        addListener: (listener: (event: MediaQueryListEvent) => void) =>
          listeners.add(listener),
        removeListener: (listener: (event: MediaQueryListEvent) => void) =>
          listeners.delete(listener),
        dispatchEvent: () => true,
      } as MediaQueryList;
    };

    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: options.memory,
    });
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: options.cores,
    });
    if (options.userAgent) {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: options.userAgent,
      });
    }
    if (options.userAgentModel) {
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        value: {
          getHighEntropyValues: async () => ({
            model: options.userAgentModel,
          }),
        },
      });
    }
    const connection = new EventTarget() as EventTarget & {
      saveData?: boolean;
      effectiveType?: string;
    };
    connection.saveData = options.saveData;
    connection.effectiveType = options.effectiveType;
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: connection,
    });
    (
      window as Window & {
        __AQ_CONNECTION__?: EventTarget & {
          saveData?: boolean;
          effectiveType?: string;
        };
      }
    ).__AQ_CONNECTION__ = connection;

    if (options.quietPerformanceObserver) {
      class QuietPerformanceObserver {
        static supportedEntryTypes = ["longtask"];
        observe() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      }
      Object.defineProperty(window, "PerformanceObserver", {
        configurable: true,
        value: QuietPerformanceObserver,
      });
    }

    if (options.blockSessionStorage) {
      const blockedKey = "infinity:adaptive-quality:v2";
      const storage = window.sessionStorage;
      const originalGetItem = storage.getItem.bind(storage);
      const originalSetItem = storage.setItem.bind(storage);
      const originalRemoveItem = storage.removeItem.bind(storage);
      Object.defineProperties(storage, {
        getItem: {
          configurable: true,
          value: (key: string) => {
            if (key === blockedKey) {
              throw new DOMException("adaptive session storage blocked");
            }
            return originalGetItem(key);
          },
        },
        setItem: {
          configurable: true,
          value: (key: string, value: string) => {
            if (key === blockedKey) {
              throw new DOMException("adaptive session storage blocked");
            }
            originalSetItem(key, value);
          },
        },
        removeItem: {
          configurable: true,
          value: (key: string) => {
            if (key === blockedKey) {
              throw new DOMException("adaptive session storage blocked");
            }
            originalRemoveItem(key);
          },
        },
      });
    }

    let bootstrapValue: unknown;
    Object.defineProperty(window, "__INFINITY_AQ_BOOTSTRAP__", {
      configurable: true,
      get: () => bootstrapValue,
      set: (value) => {
        bootstrapValue = value;
        const root = document.documentElement;
        (
          window as Window & {
            __AQ_BOOTSTRAP_CAPTURE__?: Record<string, string | null>;
          }
        ).__AQ_BOOTSTRAP_CAPTURE__ = {
          scope: root.getAttribute("data-aq-scope"),
          rendering: root.getAttribute("data-aq-rendering"),
          media: root.getAttribute("data-aq-media"),
          motion: root.getAttribute("data-aq-motion"),
          transparency: root.getAttribute("data-aq-transparency"),
        };
      },
    });
  }, preset);
}

async function bootstrapCapture(page: Page) {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __AQ_BOOTSTRAP_CAPTURE__?: Record<string, string | null>;
        }
      ).__AQ_BOOTSTRAP_CAPTURE__,
  );
}

async function adaptiveSnapshot(page: Page): Promise<AdaptiveSnapshot> {
  return page.evaluate(() => {
    const adapter = window.__INFINITY_AQ_E2E__;
    if (!adapter) throw new Error("adaptive E2E adapter is unavailable");
    return adapter.snapshot();
  });
}

async function requestedForbiddenChunks(requests: Request[]) {
  const violations: string[] = [];
  for (const request of requests) {
    if (request.resourceType() !== "script") continue;
    const pathname = new URL(request.url()).pathname;
    const marker = "/_next/static/";
    const index = pathname.indexOf(marker);
    if (index < 0) continue;
    const relativePath = decodeURIComponent(
      pathname.slice(index + marker.length),
    );
    const source = await readFile(
      path.join(frontendStaticDir, relativePath),
      "utf8",
    ).catch(() => "");
    for (const entry of forbiddenChunkMarkers) {
      if (entry.markers.every((value) => source.includes(value))) {
        violations.push(`${entry.family}:${relativePath}`);
      }
    }
  }
  return violations;
}

function isOptionalMediaRequest(url: string) {
  return (
    /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(url) ||
    /\/animations\/infloading\.json(?:[?#]|$)/i.test(url) ||
    /_skip_global_loader=1.*populate%5BMedia%5D|populate\[Media\]/i.test(url)
  );
}

function freshHomePath() {
  return `/?_aq_e2e=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test.describe("automatic adaptive quality", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalMediaFixture(page);
  });

  test("capable desktop starts at peak before hydration without UA spoofing", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "One deterministic desktop project proves the capability baseline.",
    );
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
      effectiveType: "4g",
    });

    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });

    expect(await bootstrapCapture(page)).toEqual({
      scope: "storefront",
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
      transparency: "normal",
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-aq-rendering",
      "enhanced",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-aq-media",
      "high",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-aq-motion",
      "enhanced",
    );
  });

  test("strong-first classification reaches full Safe without weakening commerce", async ({
    page,
  }) => {
    const runtime = collectStrictRuntimeErrors(page);
    const requests: Request[] = [];
    page.on("request", (request) => requests.push(request));
    await installAdaptiveCapabilities(page, {
      memory: 2,
      cores: 2,
      saveData: true,
    });

    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    expect(await bootstrapCapture(page)).toEqual({
      scope: "storefront",
      rendering: "standard",
      media: "economy",
      motion: "standard",
      transparency: "normal",
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-aq-rendering",
      "standard",
    );
    await expect(page.locator('[data-aq-hero="standard"]')).toHaveCount(1);
    await expect(
      page.locator('[data-aq-hero="standard"] picture img'),
    ).toHaveCount(1);
    const standardProductRail = page
      .locator('[data-aq-carousel="product-rail"]')
      .first();
    await expect(standardProductRail).toBeVisible({ timeout: 30_000 });
    await expect(standardProductRail).toHaveAttribute(
      "data-aq-carousel-motion",
      "lightweight",
    );
    await expect(
      page.locator("[data-aq-optional-media='gif-shell']"),
    ).toHaveCount(0);
    await expect(page.locator("video[src]")).toHaveCount(0);

    await expect
      .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
      .toBe(true);
    await page.evaluate(() =>
      window.__INFINITY_AQ_E2E__?.setTier({
        rendering: "safe",
        media: "economy",
        motion: "minimal",
      }),
    );
    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "safe",
      media: "economy",
      motion: "minimal",
    });
    await expect(page.locator('[data-aq-hero="standard"]')).toHaveCount(1);

    const skipLink = page.locator('a[href="#main-content"]').first();
    await skipLink.focus();
    await expect(skipLink).toBeFocused();

    await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}`, {
      waitUntil: "domcontentloaded",
    });
    const seededCards = page.locator(
      `[data-testid="product-card"][data-product-slug="${E2E_PRODUCT_SLUG}"]:visible`,
    );
    await expect(seededCards.first()).toBeVisible({ timeout: 30_000 });
    await expect(
      seededCards.first().getByRole("link", {
        name: /مشاهده جزئیات/,
      }),
    ).toBeVisible();

    await page.goto(`/pdp/${E2E_PRODUCT_SLUG}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("pdp-hero")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("pdp-add-to-cart")).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByTestId("pdp-add-to-cart").click();
    await expect
      .poll(() =>
        page.evaluate((title) => {
          const cart = JSON.parse(
            localStorage.getItem("cart") || "[]",
          ) as Array<{
            name?: string;
            quantity?: number;
          }>;
          return cart.find((item) => item.name === title)?.quantity ?? 0;
        }, E2E_PRODUCT_TITLE),
      )
      .toBe(1);
    await page.goto("/cart", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-testid="cart-item"]:visible').first(),
    ).toBeVisible({
      timeout: 20_000,
    });
    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(
      /\/auth\?(?:.*&)?redirect=(?:\/checkout|%2Fcheckout)/,
    );

    expect(
      requests.filter((request) => isOptionalMediaRequest(request.url())),
    ).toEqual([]);
    expect(await requestedForbiddenChunks(requests)).toEqual([]);
    runtime.assertClean();
  });

  test("product-card hover glass and previews survive Safe quality", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "Desktop hover behavior only needs one deterministic production browser.",
    );
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      memory: 2,
      cores: 2,
      saveData: true,
      reducedTransparency: true,
    });

    await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}`, {
      waitUntil: "domcontentloaded",
    });
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
      .toBe(true);
    await page.evaluate(() =>
      window.__INFINITY_AQ_E2E__?.setTier({
        rendering: "safe",
        media: "economy",
        motion: "minimal",
      }),
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-aq-rendering",
      "safe",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-aq-transparency",
      "reduced",
    );

    const card = page
      .locator(
        `[data-testid="product-card"][data-product-slug="${E2E_PRODUCT_SLUG}"]:visible`,
      )
      .filter({ has: page.getByTestId("product-card-quick-view") })
      .first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.hover();

    await expect(card.getByTestId("product-card-quick-view")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(card.getByTestId("product-card-share")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect
      .poll(() =>
        card.getByTestId("product-card-variation-overlay").evaluate((element) => {
          const transform = getComputedStyle(element).transform;
          if (transform === "none") return true;

          const matrix = new DOMMatrixReadOnly(transform);
          return (
            matrix.is2D &&
            matrix.a === 1 &&
            matrix.b === 0 &&
            matrix.c === 0 &&
            matrix.d === 1 &&
            matrix.e === 0 &&
            matrix.f === 0
          );
        }),
      )
      .toBe(true);

    const hoverStyles = await card.evaluate((element) => {
      const styles = (selector: string) => {
        const target = element.querySelector(selector);
        if (!(target instanceof HTMLElement)) return null;
        const computed = getComputedStyle(target);
        return {
          backdropFilter:
            computed.backdropFilter ||
            computed.getPropertyValue("-webkit-backdrop-filter"),
          backgroundColor: computed.backgroundColor,
          display: computed.display,
          opacity: computed.opacity,
          transform: computed.transform,
        };
      };

      return {
        favorite: styles('[data-testid="product-card-favorite"]'),
        swatches: styles(".product-card-color-badge"),
        variation: styles('[data-testid="product-card-variation-overlay"]'),
      };
    });

    expect(hoverStyles.favorite?.backdropFilter).toContain("blur(3.65px)");
    expect(hoverStyles.favorite?.backgroundColor).toContain("0.14");
    expect(hoverStyles.swatches?.backdropFilter).toContain("blur(3.65px)");
    expect(hoverStyles.swatches?.backgroundColor).toContain("0.14");
    expect(hoverStyles.variation?.backdropFilter).toContain("blur(12px)");
    expect(hoverStyles.variation?.display).toBe("block");
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(
      hoverStyles.variation?.transform,
    );
    runtime.assertClean();
  });

  test("missing APIs and blocked session storage remain neutral", async ({
    page,
  }) => {
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      blockSessionStorage: true,
    });

    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    expect(await bootstrapCapture(page)).toMatchObject({
      scope: "storefront",
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
    await expect(page.locator("#main-content")).toBeVisible();
    runtime.assertClean();
  });

  test("home decorations bleed while section content remains contained", async ({
    page,
  }, testInfo) => {
    test.skip(
      !["chromium-desktop", "chromium-mobile"].includes(testInfo.project.name),
      "Desktop and narrow/mobile geometry cover this shared layout regression.",
    );
    await installAdaptiveCapabilities(page, {
      memory: 2,
      cores: 2,
    });
    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });

    const newest = page.locator('[data-home-full-bleed="newest"]');
    const backdrop = newest.locator("[data-newest-static-backdrop]");
    await expect(newest).toBeVisible({ timeout: 30_000 });
    await expect(backdrop).toBeAttached();

    const assertFullBleed = async (selector: string) => {
      const geometry = await page.locator(selector).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          viewportWidth: window.innerWidth,
        };
      });
      expect(geometry.left).toBeLessThanOrEqual(0);
      expect(geometry.right).toBeGreaterThanOrEqual(geometry.viewportWidth);
    };

    const assertContentContained = async (selector: string) => {
      const geometry = await page.locator(selector).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          contentLeft: rect.left + Number.parseFloat(style.paddingLeft),
          contentRight: rect.right - Number.parseFloat(style.paddingRight),
          viewportWidth: window.innerWidth,
        };
      });
      expect(geometry.contentLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.contentRight).toBeLessThanOrEqual(geometry.viewportWidth);
    };

    await assertFullBleed('[data-home-full-bleed="newest"]');
    await assertContentContained('[data-home-contained-content="newest"]');
    const backdropStyle = await backdrop.evaluate((element) => {
      const style = getComputedStyle(element);
      return { display: style.display, visibility: style.visibility };
    });
    expect(backdropStyle).toEqual({
      display: "block",
      visibility: "visible",
    });

    const discounted = page.locator('[data-home-full-bleed="discounted"]');
    await expect(discounted).toBeVisible({ timeout: 30_000 });
    await assertFullBleed('[data-home-full-bleed="discounted"]');
    await assertContentContained('[data-home-contained-content="discounted"]');
  });

  test("the supplied v1.2 Safe record is discarded and replaced by v2", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "One capable desktop proves the cross-schema migration.",
    );
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
    });
    await page.addInitScript(() => {
      sessionStorage.setItem(
        "infinity:adaptive-quality:v1",
        JSON.stringify({
          schema: 1,
          policyVersion: "1.2.0",
          buildVersion: "8a03fc7-1785240384007",
          expiresAt: 1785263452859,
          lastSmoothRouteGeneration: 17,
          rolloutBucket: 7396,
          constraint: {
            rendering: "safe",
            media: "economy",
            motion: "minimal",
          },
          reasons: ["default", "slow-connection", "severe-loaf"],
          sessionHadDowngrade: true,
          sessionHadSevereEvent: true,
          smoothRouteGenerations: 1,
          smoothWindows: 1,
        }),
      );
    });

    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    expect(await bootstrapCapture(page)).toMatchObject({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
    expect(
      await page.evaluate(() => {
        const oldRecord = sessionStorage.getItem(
          "infinity:adaptive-quality:v1",
        );
        const record = JSON.parse(
          sessionStorage.getItem("infinity:adaptive-quality:v2") || "{}",
        );
        return {
          oldRecord,
          isFresh: record.expiresAt > Date.now(),
          schema: record.schema,
          policyVersion: record.policyVersion,
          runtimeConstraint: record.runtimeConstraint,
        };
      }),
    ).toMatchObject({
      oldRecord: null,
      isFresh: true,
      schema: 2,
      policyVersion: "2.0.0",
      runtimeConstraint: {
        rendering: "enhanced",
        media: "high",
        motion: "enhanced",
      },
    });
    runtime.assertClean();
  });

  test("session constraints remain isolated between tabs", async ({ page }) => {
    await installAdaptiveCapabilities(page, {
      memory: 4,
      cores: 4,
    });
    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
      .toBe(true);
    await page.evaluate(() =>
      window.__INFINITY_AQ_E2E__?.downgrade("repeated-long-task"),
    );
    expect(await adaptiveSnapshot(page)).toMatchObject({
      motion: "minimal",
    });

    const secondPage = await page.context().newPage();
    await installAdaptiveCapabilities(secondPage, {
      memory: 4,
      cores: 4,
    });
    await secondPage.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    await expect
      .poll(() =>
        secondPage.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)),
      )
      .toBe(true);
    expect(await adaptiveSnapshot(secondPage)).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
    await secondPage.close();
  });

  test("accessibility and connection preferences clamp independent axes", async ({
    page,
  }) => {
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      memory: 4,
      cores: 4,
      effectiveType: "3g",
      reducedMotion: true,
      reducedTransparency: true,
    });

    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    expect(await bootstrapCapture(page)).toEqual({
      scope: "storefront",
      rendering: "standard",
      media: "standard",
      motion: "minimal",
      transparency: "reduced",
    });
    await expect(page.locator('[data-aq-hero="standard"]')).toHaveCount(1);
    runtime.assertClean();
  });

  test("3g to 4g restores High media without mutating runtime storage", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "One capable desktop proves the reversible network overlay.",
    );
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
      effectiveType: "3g",
      quietPerformanceObserver: true,
    });
    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
      .toBe(true);
    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "enhanced",
      media: "standard",
      motion: "enhanced",
    });
    const before = await page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem("infinity:adaptive-quality:v2") || "{}",
      ),
    );

    await page.evaluate(() => {
      const connection = (
        window as Window & {
          __AQ_CONNECTION__?: EventTarget & { effectiveType?: string };
        }
      ).__AQ_CONNECTION__;
      if (!connection) throw new Error("test connection is unavailable");
      connection.effectiveType = "4g";
      connection.dispatchEvent(new Event("change"));
    });

    await expect
      .poll(async () => (await adaptiveSnapshot(page)).media)
      .toBe("high");
    const after = await page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem("infinity:adaptive-quality:v2") || "{}",
      ),
    );
    expect(after.runtimeConstraint).toEqual(before.runtimeConstraint);
    expect(after.expiresAt).toBe(before.expiresAt);
  });

  test("two clean windows recover one runtime step on the same route", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "One deterministic desktop proves same-route recovery.",
    );
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
      effectiveType: "4g",
      quietPerformanceObserver: true,
    });
    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
      .toBe(true);

    await page.evaluate(() => {
      const adapter = window.__INFINITY_AQ_E2E__;
      adapter?.setTier({
        rendering: "safe",
        media: "economy",
        motion: "minimal",
      });
      adapter?.completeObservationWindow();
      adapter?.completeObservationWindow();
    });

    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "standard",
      media: "economy",
      motion: "minimal",
      reason: "promotion",
    });
  });

  test("an allowlisted high-end UA starts at peak and remains runtime-downgradable", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "One deterministic browser proves the UA admission and promotion sequence.",
    );
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      quietPerformanceObserver: true,
    });
    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    expect(await bootstrapCapture(page)).toMatchObject({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
      .toBe(true);
    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
    const richProductRail = page
      .locator('[data-aq-carousel="product-rail"]')
      .first();
    await expect(richProductRail).toBeVisible({ timeout: 30_000 });
    await expect(richProductRail).toHaveAttribute(
      "data-aq-carousel-motion",
      "legacy-rich",
    );
    expect(
      await richProductRail
        .locator("[data-aq-carousel-track]")
        .evaluate((element) => getComputedStyle(element).transitionDuration),
    ).toContain("0.3s");

    await page.evaluate(() =>
      window.__INFINITY_AQ_E2E__?.downgrade("repeated-long-task"),
    );
    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "enhanced",
      media: "high",
      motion: "standard",
      reason: "repeated-long-task",
    });
    await expect(richProductRail).toHaveAttribute(
      "data-aq-carousel-motion",
      "lightweight",
    );
    runtime.assertClean();
  });

  test("the narrow mobile footer clears the fixed nav and scroll control", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "This is the narrow mobile regression shown in the supplied screenshot.",
    );
    await page.setViewportSize({ width: 320, height: 568 });
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
    });
    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load");
    await page.evaluate(async () => {
      if ("fonts" in document) {
        await document.fonts.ready;
      }
    });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            return (
              Math.abs(
                window.scrollY +
                  window.innerHeight -
                  document.documentElement.scrollHeight,
              ) <= 2
            );
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(page.locator("nav[data-bottom-nav]")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "بازگشت به بالا" }),
    ).toBeVisible();

    const geometry = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>("nav[data-bottom-nav]");
      const footer = document.querySelector("footer");
      const scrollButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="بازگشت به بالا"]',
      );
      if (!nav || !footer || !scrollButton) {
        throw new Error("mobile footer controls are missing");
      }
      const navRect = nav.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const buttonRect = scrollButton.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        navLeft: navRect.left,
        navRight: navRect.right,
        navTop: navRect.top,
        navOverflows: nav.scrollWidth > nav.clientWidth,
        footerBottom: footerRect.bottom,
        buttonBottom: buttonRect.bottom,
      };
    });

    expect(geometry.navLeft).toBeGreaterThanOrEqual(8);
    expect(geometry.navRight).toBeLessThanOrEqual(geometry.viewportWidth - 8);
    expect(geometry.navOverflows).toBe(false);
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.navTop - 16);
    expect(geometry.buttonBottom).toBeLessThanOrEqual(geometry.navTop - 6);
  });

  test("test-only Enhanced loads conditionally and runtime constraints persist", async ({
    page,
  }) => {
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
    });
    await page.goto(freshHomePath(), { waitUntil: "domcontentloaded" });

    await expect
      .poll(async () =>
        page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)),
      )
      .toBe(true);
    await page.evaluate(() =>
      window.__INFINITY_AQ_E2E__?.setTier({
        rendering: "enhanced",
        media: "high",
        motion: "enhanced",
      }),
    );
    await expect(page.locator('[data-aq-hero="enhanced"]')).toHaveCount(1, {
      timeout: 20_000,
    });

    await page.locator("#main-content").evaluate((node) => {
      (
        window as Window & { __AQ_COMMERCE_ROOT__?: Element }
      ).__AQ_COMMERCE_ROOT__ = node;
    });

    const expected = [
      { rendering: "enhanced", media: "high", motion: "standard" },
      { rendering: "enhanced", media: "high", motion: "minimal" },
      { rendering: "enhanced", media: "standard", motion: "minimal" },
      { rendering: "enhanced", media: "economy", motion: "minimal" },
      { rendering: "standard", media: "economy", motion: "minimal" },
      { rendering: "safe", media: "economy", motion: "minimal" },
    ] as const;
    for (const tiers of expected) {
      await page.evaluate(() =>
        window.__INFINITY_AQ_E2E__?.downgrade("raf-jank"),
      );
      expect(await adaptiveSnapshot(page)).toMatchObject(tiers);
    }

    await expect(page.locator('[data-aq-hero="enhanced"]')).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __AQ_COMMERCE_ROOT__?: Element })
            .__AQ_COMMERCE_ROOT__ === document.querySelector("#main-content"),
      ),
    ).toBe(true);

    await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}`, {
      waitUntil: "domcontentloaded",
    });
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
      .toBe(true);
    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "safe",
      media: "economy",
      motion: "minimal",
    });
    runtime.assertClean();
  });

  test("super-admin is excluded before storage and classification", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: authStorageStatePath("admin"),
    });
    const page = await context.newPage();
    await installLocalMediaFixture(page);
    await installAdaptiveCapabilities(page, {
      memory: 1,
      cores: 1,
      saveData: true,
    });
    await page.goto("/super-admin", { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-aq-scope",
      "storefront",
    );
    expect(await bootstrapCapture(page)).toBeUndefined();
    expect(
      await page.evaluate(() => {
        try {
          return [
            sessionStorage.getItem("infinity:adaptive-quality:v1"),
            sessionStorage.getItem("infinity:adaptive-quality:v2"),
          ];
        } catch {
          return [null, null];
        }
      }),
    ).toEqual([null, null]);
    await context.close();
  });
});

test.describe("adaptive quality authentication isolation", () => {
  test("logged-out account navigation redirects before account HTML renders", async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.addInitScript(() => {
      localStorage.removeItem("accessToken");
    });

    const response = await page.goto("/account?tab=profile", {
      waitUntil: "domcontentloaded",
    });
    const currentUrl = new URL(page.url());
    const accountRequest = response?.request().redirectedFrom();
    const accountResponse = await accountRequest?.response();

    expect(currentUrl.pathname).toBe("/auth");
    expect(currentUrl.searchParams.get("redirect")).toBe(
      "/account?tab=profile",
    );
    expect(accountResponse?.status()).toBe(307);
    await expect(page.locator(".public-layout.bg-white.pt-5")).toHaveCount(0);
  });
});

test.describe("adaptive quality commerce isolation", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test("full Safe downgrade during submit survives redirect, callback, and payment result", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "The real payment lifecycle runs once; all browsers cover the governor and storefront.",
    );
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
    });
    let submitNodeSurvived = false;
    let submitTierReachedSafe = false;
    const payment = await finalizeToZarinpalRedirect(page, request, {
      onSubmitStarted: async () => {
        const result = await page.evaluate(() => {
          const submit = document.querySelector(
            '[data-testid="checkout-submit"]',
          );
          window.__INFINITY_AQ_E2E__?.setTier({
            rendering: "safe",
            media: "economy",
            motion: "minimal",
          });
          const snapshot = window.__INFINITY_AQ_E2E__?.snapshot();
          return {
            sameNode:
              submit !== null &&
              submit ===
                document.querySelector('[data-testid="checkout-submit"]'),
            reachedSafe:
              snapshot?.rendering === "safe" &&
              snapshot.media === "economy" &&
              snapshot.motion === "minimal",
          };
        });
        submitNodeSurvived = result.sameNode;
        submitTierReachedSafe = result.reachedSafe;
      },
    });
    expect(submitNodeSurvived).toBe(true);
    expect(submitTierReachedSafe).toBe(true);

    await stubSuccessfulCallback(page, payment);
    await page.goto(
      `/orders/payment-callback?ResNum=${payment.orderId}&RefNum=${payment.refId}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page).toHaveURL(/\/orders\/success(?:\?.*)?$/, {
      timeout: 45_000,
    });
    await expect(page.getByTestId("order-payment-success")).toBeVisible({
      timeout: 30_000,
    });

    await page.goto(`/payment/result?orderId=${payment.orderId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("payment-result")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("heading", {
        name: "پرداخت با موفقیت ثبت شد",
      }),
    ).toBeVisible();
    runtime.assertClean();
  });

  test("SnappPay eligibility failure cannot destabilize checkout", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "The backend exception path is browser-independent.",
    );
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
    });
    const variation = await findProductVariationBySku(request);
    await resetCartToVariation(request, variation.id, 1, "customer");
    await page.route(/\/api\/payment-gateway\/snapp-eligible/i, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          message: "SNAPPAY_TEMPORARILY_UNAVAILABLE",
        }),
      }),
    );

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    const submit = page.getByTestId("checkout-submit");
    await expect(submit).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("payment-gateway-snappay")).toHaveCount(0);
    await page.evaluate(() =>
      window.__INFINITY_AQ_E2E__?.downgrade("raf-jank"),
    );
    await expect(submit).toBeVisible();
    runtime.assertClean();
  });

  test("SnappPay renders the provider title above its unchanged description", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "Checkout copy is browser-independent.",
    );
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
    });
    const variation = await findProductVariationBySku(request);
    await resetCartToVariation(request, variation.id, 1, "customer");
    await page.route(/\/api\/payment-gateway\/available/i, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          gateways: [{ code: "snappay", title: "SnappPay" }],
        }),
      }),
    );
    await page.route(/\/api\/payment-gateway\/snapp-eligible/i, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          eligible: true,
          title: "پرداخت اعتباری اسنپ پی",
          description: "تا سقف اعتبار قابل استفاده",
        }),
      }),
    );

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await selectSeededAddress(page);
    await selectFirstShipping(page);

    const gateway = page.getByTestId("payment-gateway-snappay");
    await expect(gateway).toBeVisible();
    const details = gateway.locator("div.text-right > div");
    await expect(details).toHaveCount(2);
    await expect(details.nth(0)).toHaveText("پرداخت اعتباری اسنپ پی");
    await expect(details.nth(1)).toHaveText("تا سقف اعتبار قابل استفاده");
    runtime.assertClean();
  });
});
