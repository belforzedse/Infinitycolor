import {
  measuredPerformanceRows,
  performanceP75,
  presentAnalyticsMessage,
  presentBehaviorValue,
  presentJourneyStep,
  presentPath,
  presentWindow,
  rateVital,
  REGION_OPTIONS,
} from "../presentation";
import { filterScopeText } from "../filters";

describe("behavior analytics presentation", () => {
  it("names a bad date range instead of calling it a temporary outage", () => {
    // Both spellings reach the client: the raw token from most report endpoints,
    // and the same token inside a longer message. Neither may fall through to the
    // generic /INVALID_/ branch, which would tell the operator to wait it out.
    const expected = "بازه تاریخ انتخاب‌شده معتبر نیست؛ تاریخ شروع و پایان را بررسی کنید.";
    expect(presentAnalyticsMessage("INVALID_DATE_RANGE")).toBe(expected);
    expect(presentAnalyticsMessage("Error: INVALID_DATE_RANGE")).toBe(expected);
  });

  it("turns storefront paths into readable Persian labels", () => {
    expect(presentPath("/payment/")).toBe("پرداخت");
    expect(presentPath("/checkout?token=secret")).toBe("ثبت سفارش");
    expect(presentPath("/%D9%81%D8%B1%D9%88%D8%B4%DA%AF%D8%A7%D9%87/")).toBe(
      "فهرست محصولات",
    );
    expect(presentPath("/product/%DA%A9%D9%81%D8%B4-%D9%85%D8%B1%D8%AF%D8%A7%D9%86%D9%87")).toBe(
      "محصول: کفش مردانه",
    );
  });

  it("localizes machine values without translating recognized product names", () => {
    expect(presentBehaviorValue("llm", "channel")).toBe("ابزارهای هوش مصنوعی");
    expect(presentBehaviorValue("laptop", "device")).toBe("رایانه همراه");
    expect(presentBehaviorValue("opera", "browser")).toBe("Opera");
    expect(presentBehaviorValue("add_to_cart", "event")).toBe("افزودن به سبد خرید");
    expect(presentBehaviorValue("IR", "country")).toBe("ایران");
  });

  it("reads the documented p75 performance value and omits unmeasured rows", () => {
    expect(performanceP75({ p50: 120, p75: 180, p95: 240 })).toBe(180);
    expect(performanceP75({ p75: null })).toBeNull();
    expect(
      measuredPerformanceRows([
        { name: "/", p75: 180, count: 4 },
        { name: "/payment", p75: null, count: 2 },
        { name: null, p75: 200, count: 1 },
      ]),
    ).toEqual([{ name: "/", p75: 180, count: 4 }]);
  });

  it("does not expose provider error codes to store managers", () => {
    expect(presentAnalyticsMessage("UMAMI_TIMEOUT")).toBe(
      "دریافت آمار بیش از حد معمول طول کشید. دوباره تلاش کنید.",
    );
    expect(presentAnalyticsMessage("بخش checkoutFunnel در دسترس نیست")).toBe(
      "مسیر ثبت سفارش تا خرید موقتاً در دسترس نیست.",
    );
    expect(presentAnalyticsMessage("Umami API returned an invalid payload")).toBe(
      "بخشی از اطلاعات این گزارش موقتاً در دسترس نیست.",
    );
  });

  it("separates an unconfigured collector from a temporary outage", () => {
    // The two used to collapse to the same "temporarily unavailable" line, so
    // a deployment that had never been configured looked like a passing blip.
    expect(presentAnalyticsMessage("UMAMI_CONFIG_MISSING")).toBe(
      "سامانه آمار بازدید تنظیم نشده است. تنظیمات آن باید توسط مدیر سیستم انجام شود.",
    );
    expect(presentAnalyticsMessage("UMAMI_UNAVAILABLE")).toBe(
      "سامانه آمار بازدید موقتاً در دسترس نیست.",
    );
  });
});

describe("journey and funnel presentation", () => {
  it("presents a page step as a page and an event step as an action", () => {
    expect(presentJourneyStep("/pdp/red-shirt")).toBe("محصول: red shirt");
    expect(presentJourneyStep("/")).toBe("صفحه اصلی");
    expect(presentJourneyStep("add_to_cart")).toBe("افزودن به سبد خرید");
    expect(presentJourneyStep("payment_failed")).toBe("پرداخت ناموفق");
  });

  it("writes funnel windows in Persian hours or minutes", () => {
    expect(presentWindow(60)).toBe("۱ ساعت");
    expect(presentWindow(1440)).toBe("۲۴ ساعت");
    expect(presentWindow(30)).toBe("۳۰ دقیقه");
    expect(presentWindow(undefined)).toBeNull();
  });

  it("names the production browser and OS ids Umami 3 reports", () => {
    expect(presentBehaviorValue("instagram", "browser")).toBe("مرورگر داخلی اینستاگرام");
    expect(presentBehaviorValue("chromium-webview", "browser")).toBe("مرورگر داخلی برنامه‌ها (اندروید)");
    expect(presentBehaviorValue("ios", "browser")).toBe("Safari (آیفون)");
    expect(presentBehaviorValue("crios", "browser")).toBe("Chrome (آیفون)");
    expect(presentBehaviorValue("Android OS", "os")).toBe("Android");
    expect(presentBehaviorValue("Windows 10", "os")).toBe("Windows 10");
  });

  it("does not claim every direct visit was a typed address", () => {
    expect(presentBehaviorValue("direct", "channel")).toBe("مستقیم یا بدون منبع مشخص");
    expect(presentBehaviorValue("", "referrer")).toBe("مستقیم یا بدون منبع مشخص");
  });

  it("rates Core Web Vitals against the published thresholds", () => {
    expect(rateVital("lcp", 2500)).toBe("good");
    expect(rateVital("lcp", 2501)).toBe("needs_improvement");
    expect(rateVital("lcp", 4001)).toBe("poor");
    expect(rateVital("cls", 0.05)).toBe("good");
    expect(rateVital("inp", 600)).toBe("poor");
    expect(rateVital("ttfb", null)).toBeNull();
  });

  it("says where each filter applies", () => {
    expect(filterScopeText("device")).toBe("همه بخش‌ها");
    expect(filterScopeText("utmSource")).toBe("بازدید و صفحه‌ها، نه قیف");
    expect(filterScopeText("path")).toBe("بازدید و صفحه‌ها، نه قیف");
    expect(filterScopeText("productId")).toBe("فقط شواهد محصول");
  });

  it("offers every province as its Umami region code", () => {
    expect(REGION_OPTIONS).toHaveLength(31);
    expect(REGION_OPTIONS).toContainEqual({ value: "IR-23", label: "تهران" });
  });

  it("explains drill-down failures in words", () => {
    expect(presentAnalyticsMessage("INVALID_CONVERSION_DETAIL")).toBe("این نمای قیف پشتیبانی نمی‌شود.");
    expect(presentAnalyticsMessage("UMAMI_PARTIAL")).toMatch(/ردیف‌های ناقص/);
  });
});
