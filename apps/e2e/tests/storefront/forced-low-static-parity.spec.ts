import { expect, test, type Page, type Request } from "@playwright/test";
import {
  E2E_CATEGORY_SLUG,
  E2E_PRODUCT_SLUG,
  E2E_PRODUCT_TITLE,
} from "../../fixtures/storefront";
import { installLocalMediaFixture } from "../../helpers/local-media";
import { isExpectedHarnessConsoleError } from "../../helpers/runtime-console";

function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !isExpectedHarnessConsoleError(message)
    ) {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  return errors;
}

function isMovingMedia(request: Request) {
  return /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(request.url());
}

test("forced lowest tier stays complete through core storefront discovery and cart flow", async ({
  page,
}, testInfo) => {
  const errors = collectRuntimeErrors(page);
  const movingMediaRequests: string[] = [];
  page.on("request", (request) => {
    if (isMovingMedia(request)) movingMediaRequests.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem("pdp_debug", "0");
  });
  await installLocalMediaFixture(page);

  if (testInfo.project.name === "chromium-laptop-1280") {
    testInfo.setTimeout(120_000);
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: (750 * 1024) / 8,
      uploadThroughput: (250 * 1024) / 8,
      connectionType: "cellular3g",
    });
  }

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-aq-rendering",
    "safe",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-aq-media",
    "economy",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-aq-motion",
    "minimal",
  );
  await expect(page.locator('[data-aq-hero="standard"]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.locator('[data-aq-carousel="product-rail"]').first(),
  ).toHaveAttribute("data-aq-carousel-motion", "lightweight", {
    timeout: 30_000,
  });

  const hiddenRevealCount = await page.locator(".aq-reveal").evaluateAll(
    (elements) =>
      elements.filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.opacity === "0" ||
          style.visibility === "hidden" ||
          rect.width === 0 ||
          rect.height === 0
        );
      }).length,
  );
  expect(hiddenRevealCount).toBe(0);

  const infinitygram = page.locator('[data-aq-infinitygram-layout="shared"]');
  if (await infinitygram.count()) {
    await expect(infinitygram).toHaveAttribute(
      "data-aq-infinitygram-media",
      "static",
    );
    expect(await infinitygram.locator("article").count()).toBeGreaterThan(0);
  }

  await page.screenshot({
    path: testInfo.outputPath("forced-low-home.png"),
    fullPage: true,
  });

  await page.goto(`/plp/category/${E2E_CATEGORY_SLUG}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page
      .locator(
        `[data-testid="product-card"][data-product-slug="${E2E_PRODUCT_SLUG}"]:visible`,
      )
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  await page.goto(`/pdp/${E2E_PRODUCT_SLUG}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("pdp-hero")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-aq-pdp-zoom="available"]')).toBeVisible();
  const thumbnails = page.locator("button[data-thumbnail-index]");
  expect(await thumbnails.count()).toBeGreaterThan(0);
  await expect(thumbnails.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pdp-add-to-cart")).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.getByTestId("pdp-cart-action")).toHaveAttribute(
    "data-cart-ready",
    "true",
    { timeout: 45_000 },
  );
  await page.screenshot({
    path: testInfo.outputPath("forced-low-pdp.png"),
    fullPage: true,
  });
  await page.getByTestId("pdp-add-to-cart").click();
  await expect
    .poll(
      () =>
        page.evaluate((title) => {
          const cart = JSON.parse(localStorage.getItem("cart") || "[]") as Array<{
            name?: string;
            quantity?: number;
          }>;
          return cart.find((item) => item.name === title)?.quantity ?? 0;
        }, E2E_PRODUCT_TITLE),
      { timeout: 30_000 },
    )
    .toBe(1);

  await page.goto("/cart", { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[data-testid="cart-item"]:visible').first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("link", { name: /تسویه|ادامه خرید|ثبت سفارش/ }).first(),
  ).toBeVisible();

  expect(movingMediaRequests).toEqual([]);
  expect(errors).toEqual([]);
});
