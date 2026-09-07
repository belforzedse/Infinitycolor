import {
  measuredPerformanceRows,
  performanceP75,
  presentAnalyticsMessage,
  presentBehaviorValue,
  presentPath,
} from "../presentation";

describe("behavior analytics presentation", () => {
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
      "مسیر خرید موقتاً در دسترس نیست.",
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
