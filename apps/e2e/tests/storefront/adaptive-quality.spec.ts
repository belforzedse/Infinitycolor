import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expect,
  test,
  type Browser,
  type Page,
  type Request,
} from "@playwright/test";
import { E2E_CATEGORY_SLUG, E2E_PRODUCT_SLUG } from "../../fixtures/storefront";
import { authStorageStatePath } from "../../helpers/auth";
import {
  findProductVariationBySku,
  resetCartToVariation,
} from "../../helpers/api";
import { storefrontBaseURL } from "../../helpers/env";
import {
  finalizeToZarinpalRedirect,
  stubSuccessfulCallback,
} from "../../helpers/payment";

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

function collectStrictRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
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
      try {
        Object.defineProperty(window, "sessionStorage", {
          configurable: true,
          get() {
            throw new DOMException("session storage blocked");
          },
        });
      } catch {
        const blocked = window.sessionStorage;
        Object.defineProperties(blocked, {
          getItem: {
            configurable: true,
            value: () => {
              throw new DOMException("session storage blocked");
            },
          },
          setItem: {
            configurable: true,
            value: () => {
              throw new DOMException("session storage blocked");
            },
          },
        });
      }
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
    /\.(?:gif|mp4|webm|mov)(?:[?#]|$)/i.test(url) ||
    /\/animations\/infloading\.json(?:[?#]|$)/i.test(url) ||
    /_skip_global_loader=1.*populate%5BMedia%5D|populate\[Media\]/i.test(url)
  );
}

test.describe("automatic adaptive quality", () => {
  test("Safe is present before hydration and preserves the guest commerce flow", async ({
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

    await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(await bootstrapCapture(page)).toEqual({
      scope: "storefront",
      rendering: "safe",
      media: "economy",
      motion: "minimal",
      transparency: "normal",
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-aq-rendering",
      "safe",
    );
    await expect(page.locator('[data-aq-hero="static"]')).toHaveCount(1);
    await expect(
      page.locator('[data-aq-hero="static"] picture img'),
    ).toHaveCount(1);
    const optionalShells = page.locator("[data-aq-optional-media='gif-shell']");
    if ((await optionalShells.count()) > 0) {
      await expect(optionalShells.first()).toBeAttached();
    }
    await expect(page.locator("video[src]")).toHaveCount(0);

    const skipLink = page.locator('a[href="#main-content"]').first();
    await skipLink.focus();
    await expect(skipLink).toBeFocused();

    await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}`, {
      waitUntil: "domcontentloaded",
    });
    const seededCards = page.locator(
      `[data-testid="product-card"][data-product-slug="${E2E_PRODUCT_SLUG}"]`,
    );
    await expect(seededCards).toHaveCount(1, { timeout: 30_000 });
    await expect(
      seededCards.getByRole("link", {
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
    await page.goto("/cart", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("cart-item").first()).toBeVisible({
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

  test("missing APIs and blocked session storage remain neutral", async ({
    page,
  }) => {
    const runtime = collectStrictRuntimeErrors(page);
    await installAdaptiveCapabilities(page, {
      blockSessionStorage: true,
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(await bootstrapCapture(page)).toMatchObject({
      scope: "storefront",
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
    await expect(page.locator("#main-content")).toBeVisible();
    runtime.assertClean();
  });

  test("expired and version-mismatched session records are discarded", async ({
    page,
  }) => {
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
          policyVersion: "stale-policy",
          buildVersion: "stale-build",
          expiresAt: Date.now() - 1,
          rolloutBucket: 4,
          constraint: {
            rendering: "safe",
            media: "economy",
            motion: "minimal",
          },
          reasons: ["session-constraint"],
        }),
      );
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(await bootstrapCapture(page)).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
    expect(
      await page.evaluate(() => {
        const record = JSON.parse(
          sessionStorage.getItem("infinity:adaptive-quality:v1") || "{}",
        );
        return {
          isFresh: record.expiresAt > Date.now(),
          policyVersion: record.policyVersion,
          constraint: record.constraint,
        };
      }),
    ).toMatchObject({
      isFresh: true,
      constraint: {
        rendering: "standard",
        media: "standard",
        motion: "standard",
      },
    });
    runtime.assertClean();
  });

  test("session constraints remain isolated between tabs", async ({ page }) => {
    await installAdaptiveCapabilities(page, {
      memory: 8,
      cores: 8,
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
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
      memory: 8,
      cores: 8,
    });
    await secondPage.goto("/", { waitUntil: "domcontentloaded" });
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
      memory: 8,
      cores: 8,
      effectiveType: "3g",
      reducedMotion: true,
      reducedTransparency: true,
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(await bootstrapCapture(page)).toEqual({
      scope: "storefront",
      rendering: "standard",
      media: "economy",
      motion: "minimal",
      transparency: "reduced",
    });
    await expect(page.locator('[data-aq-hero="static"]')).toHaveCount(1);
    runtime.assertClean();
  });

  test("an allowlisted high-end UA promotes to peak only after smooth proof", async ({
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
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
      .toBe(true);

    const finishSmoothWindow = async () => {
      await page.evaluate(() =>
        window.__INFINITY_AQ_E2E__?.startObservationWindow(1_000),
      );
      await page.waitForTimeout(1_050);
    };
    await finishSmoothWindow();
    await page.evaluate(() => window.__INFINITY_AQ_E2E__?.route());
    await finishSmoothWindow();
    await page.evaluate(() => window.__INFINITY_AQ_E2E__?.route());
    await finishSmoothWindow();

    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
    await page.evaluate(() => window.__INFINITY_AQ_E2E__?.route());
    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "enhanced",
      media: "standard",
      motion: "standard",
      reason: "promotion",
    });

    await finishSmoothWindow();
    await page.evaluate(() => window.__INFINITY_AQ_E2E__?.route());
    await finishSmoothWindow();
    await page.evaluate(() => window.__INFINITY_AQ_E2E__?.route());
    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
      reason: "promotion",
    });
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
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
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
    await page.goto("/", { waitUntil: "domcontentloaded" });

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
    expect(await adaptiveSnapshot(page)).toMatchObject({
      rendering: "safe",
      media: "economy",
      motion: "minimal",
    });
    runtime.assertClean();
  });

  test("super-admin is excluded before storage and classification", async ({
    page,
  }) => {
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
          return sessionStorage.getItem("infinity:adaptive-quality:v1");
        } catch {
          return null;
        }
      }),
    ).toBeNull();
  });
});

test.describe("adaptive quality without JavaScript", () => {
  test("semantic storefront content remains visible", async ({
    browser,
  }: {
    browser: Browser;
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "One no-JS production proof is sufficient; tier parity runs in every browser.",
    );
    const context = await browser.newContext({
      baseURL: storefrontBaseURL(),
      javaScriptEnabled: false,
      locale: "fa-IR",
    });
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#main-content")).toBeVisible();
    await expect(page.getByText("جدیدترین ها").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-aq-scope",
      "storefront",
    );
    await context.close();
  });
});

test.describe("adaptive quality commerce isolation", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test("downgrade during submit survives redirect, callback, and payment result", async ({
    page,
    request,
  }, testInfo) => {
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
    const payment = await finalizeToZarinpalRedirect(page, request, {
      onSubmitStarted: async () => {
        submitNodeSurvived = await page.evaluate(() => {
          const submit = document.querySelector(
            '[data-testid="checkout-submit"]',
          );
          window.__INFINITY_AQ_E2E__?.downgrade("repeated-long-task");
          return (
            submit !== null &&
            submit === document.querySelector('[data-testid="checkout-submit"]')
          );
        });
      },
    });
    expect(submitNodeSurvived).toBe(true);

    await stubSuccessfulCallback(page, payment);
    await page.goto(
      `/orders/payment-callback?ResNum=${payment.orderId}&RefNum=${payment.refId}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page).toHaveURL(
      new RegExp(`/payment/result\\?.*orderId=${payment.orderId}`),
      { timeout: 45_000 },
    );
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
});
