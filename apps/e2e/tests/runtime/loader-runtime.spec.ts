import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const playerRequire = createRequire(
  require.resolve("@lottiefiles/dotlottie-react"),
);
const wasm = resolve(
  dirname(playerRequire.resolve("@lottiefiles/dotlottie-web")),
  "dotlottie-player.wasm",
);
const API = "http://127.0.0.1:4351";

for (const enhanced of [true, false]) {
  test(`production loader preserves content through visibility changes (${enhanced ? "enhanced" : "safe"})`, async ({
    page,
    context,
  }, testInfo) => {
    const errors: string[] = [];
    const enhancementRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/hydration|did not match/i.test(message.text()))
        errors.push(message.text());
    });
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".wasm")) {
        enhancementRequests.push("wasm");
        await route.fulfill({
          path: wasm,
          contentType: "application/wasm",
          headers: { "access-control-allow-origin": "*" },
        });
      } else if (url.pathname === "/animations/infloading.json") {
        enhancementRequests.push("animation");
        await route.continue();
      } else if (url.origin === API && url.pathname === "/api/loader-fixture") {
        await pending;
        await route.fulfill({
          json: {},
          headers: { "access-control-allow-origin": "*" },
        });
      } else if (url.origin === "http://localhost:2889") {
        await route.fulfill({
          status: 401,
          json: {},
          headers: {
            "access-control-allow-origin": "http://127.0.0.1:4350",
            "access-control-allow-credentials": "true",
          },
        });
      } else if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        await route.continue();
      } else await route.abort("blockedbyclient");
    });
    await page.addInitScript(() => {
      localStorage.setItem("pwa-prompt-dismissed-permanently", "true");
    });
    try {
      await page.goto("/categories");
      await expect
        .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
        .toBe(true);
      await page.evaluate(
        (high) =>
          window.__INFINITY_AQ_E2E__?.setTier(
            high
              ? { rendering: "enhanced", media: "high", motion: "enhanced" }
              : { rendering: "safe", media: "economy", motion: "minimal" },
          ),
        enhanced,
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-aq-rendering",
        enhanced ? "enhanced" : "safe",
      );
      enhancementRequests.length = 0;
      await page.evaluate((api) => {
        void fetch(`${api}/api/loader-fixture`).catch(() => undefined);
      }, API);
      const overlay = page.locator("div.fixed.inset-0.z-\\[1000\\]");
      await expect(overlay).toBeVisible();
      if (enhanced) {
        await expect(overlay.locator("canvas")).toBeVisible();
        await expect
          .poll(() =>
            overlay
              .locator("canvas")
              .evaluate(
                (canvas) =>
                  getComputedStyle(canvas.parentElement!.parentElement!)
                    .opacity,
              ),
          )
          .toBe("1");
        expect(enhancementRequests).toContain("wasm");
      } else {
        await expect(overlay.locator("canvas")).toHaveCount(0);
        expect(enhancementRequests).toEqual([]);
      }
      await page.screenshot({
        path: testInfo.outputPath("loader-before-hidden.png"),
      });
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "hidden",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(overlay.locator("canvas")).toHaveCount(0);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      if (enhanced) {
        await expect(overlay.locator("canvas")).toBeVisible();
      } else await expect(overlay.locator("canvas")).toHaveCount(0);
      // A remounted optional renderer can still be loading. Require a visible
      // indicator throughout recovery rather than treating its presence as readiness.
      await expect
        .poll(() =>
          overlay.evaluate((root) => {
            const spinner = root.querySelector(".animate-spin")!;
            const canvas = root.querySelector("canvas");
            return Math.max(
              Number(getComputedStyle(spinner.parentElement!).opacity),
              canvas
                ? Number(
                    getComputedStyle(canvas.parentElement!.parentElement!)
                      .opacity,
                  )
                : 0,
            );
          }),
        )
        .toBeGreaterThan(0.9);
      await page.screenshot({
        path: testInfo.outputPath("loader-after-visible.png"),
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      release();
      await expect(overlay).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      release();
    }
  });
}
