import { expect, test, type Page } from "@playwright/test";
import { installLocalMediaFixture } from "../../helpers/local-media";

type StaticComposition = {
  sections: number;
  headings: number;
  links: number;
  buttons: number;
  productCards: number;
  mediaItems: number;
  heroHref: string | null;
  heroRect: { width: number; height: number };
  railCardCounts: number[];
  railRects: Array<{ width: number; height: number }>;
  infinitygramCardCount: number;
  infinitygramRects: Array<{ width: number; height: number }>;
};

function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  return errors;
}

async function captureComposition(page: Page): Promise<StaticComposition> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };
    const countVisible = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).filter(visible).length;
    const rectOf = (element: Element | null) => {
      if (!element) return { width: 0, height: 0 };
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    const hero = document.querySelector(
      '[data-aq-hero="enhanced"], [data-aq-hero="standard"]',
    );
    const rails = Array.from(
      document.querySelectorAll('[data-aq-carousel="product-rail"]'),
    ).filter(visible);
    const infinitygramCards = Array.from(
      document.querySelectorAll(
        '[data-aq-infinitygram-layout="shared"] article',
      ),
    ).filter(visible);

    return {
      sections: countVisible("main section"),
      headings: countVisible("main h1, main h2, main h3"),
      links: countVisible("main a"),
      buttons: countVisible("main button"),
      productCards: countVisible('main [data-testid="product-card"]'),
      mediaItems: countVisible("main img, main video"),
      heroHref: hero?.querySelector("a")?.getAttribute("href") ?? null,
      heroRect: rectOf(hero),
      railCardCounts: rails.map(
        (rail) =>
          Array.from(
            rail.querySelectorAll('[data-testid="product-card"]'),
          ).filter(visible).length,
      ),
      railRects: rails.map(rectOf),
      infinitygramCardCount: infinitygramCards.length,
      infinitygramRects: infinitygramCards.map(rectOf),
    };
  });
}

function expectCloseRects(
  actual: Array<{ width: number; height: number }>,
  expected: Array<{ width: number; height: number }>,
) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((rect, index) => {
    expect(Math.abs(rect.width - expected[index].width)).toBeLessThanOrEqual(2);
    expect(Math.abs(rect.height - expected[index].height)).toBeLessThanOrEqual(
      2,
    );
  });
}

test("a frozen Enhanced home frame has the same static composition at the lowest tier", async ({
  page,
}) => {
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("analytics-consent", "denied");
    localStorage.setItem("pdp_debug", "0");
  });
  await installLocalMediaFixture(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
    .toBe(true);
  await expect(
    page.locator('[data-aq-carousel="product-rail"]').first(),
  ).toBeVisible({ timeout: 30_000 });

  await page.evaluate(() =>
    window.__INFINITY_AQ_E2E__?.setTier({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    }),
  );
  await expect(page.locator('[data-aq-hero="enhanced"]')).toBeVisible({
    timeout: 30_000,
  });
  // Compare the final Enhanced composition, not an in-flight reveal/slide frame.
  await page.waitForTimeout(1_000);

  const secondDot = page.getByRole("button", { name: "Go to slide 2" });
  if (await secondDot.count()) {
    await secondDot.click();
  }
  const enhanced = await captureComposition(page);

  await page.evaluate(() =>
    window.__INFINITY_AQ_E2E__?.setTier({
      rendering: "safe",
      media: "economy",
      motion: "minimal",
    }),
  );
  await expect(page.locator('[data-aq-hero="standard"]')).toBeVisible();
  const infinitygram = page.locator('[data-aq-infinitygram-layout="shared"]');
  if (await infinitygram.count()) {
    await expect(infinitygram).toHaveAttribute(
      "data-aq-infinitygram-media",
      "static",
    );
  }

  const lowest = await captureComposition(page);
  expect(lowest).toMatchObject({
    sections: enhanced.sections,
    headings: enhanced.headings,
    links: enhanced.links,
    buttons: enhanced.buttons,
    productCards: enhanced.productCards,
    mediaItems: enhanced.mediaItems,
    heroHref: enhanced.heroHref,
    railCardCounts: enhanced.railCardCounts,
    infinitygramCardCount: enhanced.infinitygramCardCount,
  });
  expect(
    Math.abs(lowest.heroRect.width - enhanced.heroRect.width),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(lowest.heroRect.height - enhanced.heroRect.height),
  ).toBeLessThanOrEqual(2);
  expectCloseRects(lowest.railRects, enhanced.railRects);
  expectCloseRects(lowest.infinitygramRects, enhanced.infinitygramRects);
  expect(errors).toEqual([]);
});
