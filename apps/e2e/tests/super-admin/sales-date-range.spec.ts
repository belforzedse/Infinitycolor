import { expect, test, type Page, type Request } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { assertNonProductionTarget } from "../../helpers/admin";
import { prepareStorefrontPage } from "../../helpers/page";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// LEGACY_SALES_DATA_CUTOFF in apps/admin/.../reports/shared/reportDates.ts.
const LEGACY_SALES_DATA_CUTOFF = "2026-09-14";

function queryDate(url: string, key: "start" | "end"): string | null {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    const match = url.match(new RegExp(`[?&]${key}=([^&]+)`));
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
}

function isDateOnlyReportRequest(url: string, suffix: string): boolean {
  if (!url.includes(`/reports/${suffix}`)) return false;
  const start = queryDate(url, "start");
  const end = queryDate(url, "end");
  return DATE_ONLY.test(start ?? "") && DATE_ONLY.test(end ?? "");
}

function rangeFromRequest(request: Request): { start: string; end: string } {
  return {
    start: queryDate(request.url(), "start") ?? "",
    end: queryDate(request.url(), "end") ?? "",
  };
}

function daySpan(range: { start: string; end: string }): number {
  return (
    (Date.parse(`${range.end}T00:00:00`) - Date.parse(`${range.start}T00:00:00`)) /
    86_400_000
  );
}

function jalaliParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function jalaliPartsOfDateOnly(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return jalaliParts(new Date(Date.UTC(year, month - 1, day, 12)), "UTC");
}

/** nuqs omits keys that still match their defaults, so `end` may be absent when it is today. */
function tehranDateOnly(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

async function clickPresetAndCaptureOverview(
  page: Page,
  label: string,
): Promise<{ start: string; end: string }> {
  const pending = page.waitForRequest((request) =>
    isDateOnlyReportRequest(request.url(), "overview"),
  );
  await page.getByRole("button", { name: label }).click();
  return rangeFromRequest(await pending);
}

async function urlRange(page: Page): Promise<{ start: string; end: string }> {
  await expect
    .poll(() => new URL(page.url()).searchParams.get("start") ?? "")
    .toMatch(DATE_ONLY);
  const params = new URL(page.url()).searchParams;
  const start = params.get("start") ?? "";
  const end = params.get("end") ?? tehranDateOnly();
  expect(end).toMatch(DATE_ONLY);
  return { start, end };
}

test.describe("admin sales date-range filters", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Sales date-range coverage is desktop-only.",
    );
    assertNonProductionTarget();
  });

  test("@admin the sales period pickers stay equal width and drive date-only queries", async ({
    page,
  }) => {
    const runtime = await prepareStorefrontPage(page);

    const firstOverview = page.waitForRequest((request) =>
      isDateOnlyReportRequest(request.url(), "overview"),
    );
    await page.goto("/sales", { waitUntil: "domcontentloaded" });
    const initial = rangeFromRequest(await firstOverview);
    expect(initial.start).toMatch(DATE_ONLY);
    expect(initial.end).toMatch(DATE_ONLY);

    const startInput = page.getByRole("textbox", { name: "تاریخ شروع" });
    const endInput = page.getByRole("textbox", { name: "تاریخ پایان" });
    await expect(startInput).toBeVisible({ timeout: 30_000 });
    await expect(endInput).toBeVisible();

    const startBox = await startInput.boundingBox();
    const endBox = await endInput.boundingBox();
    expect(startBox, "start date input is laid out").toBeTruthy();
    expect(endBox, "end date input is laid out").toBeTruthy();
    if (startBox && endBox) {
      expect(Math.abs(startBox.width - endBox.width)).toBeLessThan(8);
    }

    const seven = await clickPresetAndCaptureOverview(page, "۷ روز گذشته");
    expect(daySpan(seven)).toBe(7);

    // A period starting before the storefront cutover shows the legacy-site
    // notice instead of fetching a partial range; its button clamps the start.
    const thirtyStart = tehranDateOnly(new Date(Date.now() - 30 * 86_400_000));
    if (thirtyStart < LEGACY_SALES_DATA_CUTOFF) {
      await page.getByRole("button", { name: "۳۰ روز گذشته" }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "سایت قبلی" }),
      ).toBeVisible();
      const clampedPending = page.waitForRequest((request) =>
        isDateOnlyReportRequest(request.url(), "overview"),
      );
      await page.getByRole("button", { name: /^نمایش از/ }).click();
      expect(rangeFromRequest(await clampedPending).start).toBe(
        LEGACY_SALES_DATA_CUTOFF,
      );
    } else {
      const thirty = await clickPresetAndCaptureOverview(page, "۳۰ روز گذشته");
      expect(daySpan(thirty)).toBe(30);
    }

    const thisMonth = await clickPresetAndCaptureOverview(page, "این ماه");
    const startJalali = jalaliPartsOfDateOnly(thisMonth.start);
    const todayJalali = jalaliParts(new Date(), "Asia/Tehran");
    expect(startJalali.day).toBe(1);
    expect(startJalali.year).toBe(todayJalali.year);
    expect(startJalali.month).toBe(todayJalali.month);
    expect(await urlRange(page)).toEqual(thisMonth);

    // The sidebar's open sales menu repeats these links; use the page's sub-nav.
    const salesNav = page.getByLabel("بخش‌های فروش");
    await salesNav.getByRole("link", { name: "تفکیک فروش" }).click();
    await expect(page).toHaveURL(/\/sales\/breakdown/, { timeout: 30_000 });
    expect(await urlRange(page)).toEqual(thisMonth);

    await salesNav.getByRole("link", { name: "فروش محصولات" }).click();
    await expect(page).toHaveURL(/\/sales\/products/, { timeout: 30_000 });
    await expect(page.getByRole("textbox", { name: "تاریخ شروع" })).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "تاریخ پایان" })).toHaveCount(1);
    await expect(page.getByText("از تاریخ")).toHaveCount(0);

    await page.getByRole("button", { name: "عملکرد محصولات" }).click();
    await expect(page.getByPlaceholder("نام محصول یا کد...")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("textbox", { name: "تاریخ شروع" })).toHaveCount(1);

    const liquidityPending = page.waitForRequest((request) =>
      isDateOnlyReportRequest(request.url(), "liquidity"),
    );
    await salesNav.getByRole("link", { name: "نقدینگی" }).click();
    await expect(page).toHaveURL(/\/sales\/liquidity/, { timeout: 30_000 });
    const liquidity = rangeFromRequest(await liquidityPending);
    expect(liquidity).toEqual(thisMonth);

    runtime.assertClean();
  });
});
