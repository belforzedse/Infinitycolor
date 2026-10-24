import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const { BUILD_VERSION: buildVersion } = JSON.parse(
  readFileSync(
    new URL(
      "../../../frontend/src/constants/build-version.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const mainPhoto = (page: Page) =>
  page.getByTestId("pdp-hero").locator("[data-aq-pdp-placeholder] ~ img");
const thumb = (page: Page, index: number) =>
  page.locator(`[data-thumbnail-index="${index}"]:visible`);

test.beforeEach(async ({ page }) => {
  await page.route("https://gallery-fixture.example/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await page.request.get(
      `http://localhost:4311${url.pathname}`,
    );
    await route.fulfill({ response });
  });
  // Anonymous session boundary, isolated from any developer session/runtime.
  await page.route("http://localhost:2889/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Unauthenticated" }),
      headers: {
        "access-control-allow-origin": "http://localhost:4310",
        "access-control-allow-credentials": "true",
      },
    }),
  );
});

for (const quality of ["safe", "automatic"] as const) {
  test(`${quality}: color gallery, fallback, keyboard and variant selection`, async ({
    page,
  }, info) => {
    if (quality === "safe") {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript((version) => {
        Object.defineProperty(navigator, "deviceMemory", {
          configurable: true,
          value: 2,
        });
        Object.defineProperty(navigator, "hardwareConcurrency", {
          configurable: true,
          value: 2,
        });
        Object.defineProperty(navigator, "connection", {
          configurable: true,
          value: {
            saveData: true,
            effectiveType: "2g",
            addEventListener() {},
            removeEventListener() {},
          },
        });
        const now = Date.now();
        sessionStorage.setItem(
          "infinity:adaptive-quality:v2",
          JSON.stringify({
            schema: 2,
            policyVersion: "2.0.0",
            buildVersion: version,
            createdAt: now,
            expiresAt: now + 6 * 60 * 60 * 1000,
            rolloutBucket: 0,
            runtimeConstraint: {
              rendering: "safe",
              media: "economy",
              motion: "minimal",
            },
            penaltyExpiresAt: now + 30 * 60 * 1000,
            lastBadAt: now,
            consecutiveSmoothWindows: 0,
            lastReason: "session-constraint",
          }),
        );
      }, buildVersion || "dev");
    }
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/hydrat|empty string.*src/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/pdp/gallery-colors");
    await expect(page.getByTestId("pdp-hero")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    if (quality === "safe") {
      await expect(page.locator("html")).toHaveAttribute(
        "data-aq-rendering",
        "safe",
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-aq-media",
        "economy",
      );
    }
    await expect(mainPhoto(page)).toHaveAttribute(
      "src",
      /gallery-photo-1\.png/,
    );
    await expect(thumb(page, 0)).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "تصویر بعدی", exact: true }).click();

    await expect(mainPhoto(page)).toHaveAttribute(
      "src",
      /gallery-photo-2\.png/,
    );
    const blue = page
      .getByTestId("pdp-color-option")
      .filter({ hasText: "آبی" });

    await blue.evaluate((element) => {
      element.focus({ preventScroll: true });
    });
    await page.keyboard.press("Enter");

    await expect(mainPhoto(page)).toHaveAttribute(
      "src",
      /gallery-photo-30\.png/,
    );

    await expect(thumb(page, 3)).toHaveAttribute("aria-pressed", "true");

    await thumb(page, 4).evaluate((element) => {
      element.focus({ preventScroll: true });
    });

    const pageScrollBefore = await page.evaluate(() => window.scrollY);

    await page.keyboard.press("Space");

    await expect(mainPhoto(page)).toHaveAttribute(
      "src",
      /gallery-photo-40\.png/,
    );

    await page.waitForTimeout(500);

    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
    const media = page.locator('[data-aq-pdp-gallery-media="image"]');
    await expect(media).toHaveAttribute("data-aq-pdp-zoom", "available");
    if (info.project.name === "desktop") {
      await mainPhoto(page).hover();
      await page.mouse.wheel(0, -100);
      await expect(mainPhoto(page).locator("..")).not.toHaveCSS(
        "transform",
        "matrix(1, 0, 0, 1, 0, 0)",
      );
    }
    await page
      .getByRole("button", { name: "انتخاب سایز M", exact: true })
      .click();
    await page
      .getByRole("button", { name: "انتخاب مدل B", exact: true })
      .click();
    await expect(page.getByTestId("pdp-hero")).toContainText("۲۲٬۲۰۰ تومان");
    await expect(mainPhoto(page)).toHaveAttribute(
      "src",
      /gallery-photo-40\.png/,
    );
    await page.screenshot({
      path: info.outputPath(`${quality}-blue.png`),
      fullPage: false,
    });
    await page
      .getByTestId("pdp-color-option")
      .filter({ hasText: "سبز" })
      .click();
    await expect(mainPhoto(page)).toHaveAttribute(
      "src",
      /gallery-photo-1\.png/,
    );
    await expect(
      page.getByTestId("pdp-hero").locator("[data-thumbnail-index]:visible"),
    ).toHaveCount(5);
    await page.getByRole("button", { name: "تصویر بعدی", exact: true }).click();
    await expect(mainPhoto(page)).toHaveAttribute(
      "src",
      /gallery-photo-2\.png/,
    );
    await page
      .getByRole("button", { name: "افزودن به سبد خرید", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem("cart") || "[]")),
      )
      .toEqual([
        expect.objectContaining({
          variationId: "322",
          color: "سبز",
          size: "M",
          model: "B",
          price: 32200,
          quantity: 1,
        }),
      ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
test("single-color product starts on the cover and allows photo selection", async ({
  page,
}) => {
  await page.goto("/pdp/gallery-single");

  await expect(mainPhoto(page)).toHaveAttribute("src", /gallery-photo-1\.png/);

  await expect(page.getByTestId("pdp-color-option")).toHaveCount(0);

  await thumb(page, 2).click();

  await expect(mainPhoto(page)).toHaveAttribute("src", /gallery-photo-20\.png/);
});
