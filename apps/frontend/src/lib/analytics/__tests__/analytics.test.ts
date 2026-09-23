describe("provider-neutral storefront analytics", () => {
  const track = jest.fn();
  const identify = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.umami = { track, identify } as NonNullable<Window["umami"]>;
    delete window.__analyticsPendingCalls;
    process.env.NEXT_PUBLIC_UMAMI_ENABLE_DEV = "true";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_UMAMI_ENABLE_DEV;
    delete window.umami;
  });

  it("fails closed outside production unless development tracking is explicitly enabled", async () => {
    const analytics = await import("../index");
    expect(analytics.isAnalyticsEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_UMAMI_ENABLE_DEV = "false";
    expect(analytics.isAnalyticsEnabled()).toBe(false);
  });

  it("sends allowlisted event data for every visitor, with no consent step", async () => {
    const analytics = await import("../index");
    analytics.trackAnalyticsEvent({
      category: "ecommerce",
      action: "select_item",
      name: "42:عنوان محصول:pos=3",
      value: 125_000,
    });
    expect(track).toHaveBeenCalledWith(
      "select_item",
      expect.objectContaining({
        product_id: "42",
        position: 3,
        value_irr: 1_250_000,
        currency: "IRR",
      }),
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain("عنوان محصول");
    // Do Not Track no longer strips data either.
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
    expect(
      analytics.analyticsBeforeSend("event", {
        name: "add_to_cart",
        url: "/plp",
        data: { product_id: "42", quantity: 2 },
      }),
    ).toEqual({ name: "add_to_cart", url: "/plp", data: { product_id: "42", quantity: 2 } });
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "0" });
  });

  it("drops unknown event properties and PII-shaped values", async () => {
    const analytics = await import("../index");
    analytics.trackAnalyticsEvent({
      category: "ecommerce",
      action: "view_cart",
      properties: {
        email: "shopper@example.com",
        rawQuery: "phone 09123456789",
        unexpected: "must-not-leave",
      },
    });
    expect(track).toHaveBeenCalledWith("view_cart", undefined);
    expect(JSON.stringify(track.mock.calls)).not.toContain("must-not-leave");
    expect(JSON.stringify(track.mock.calls)).not.toContain("09123456789");
  });

  it("keeps an explicit quantity or result count instead of overwriting it", async () => {
    const analytics = await import("../index");
    analytics.trackAnalyticsEvent({
      category: "engagement",
      action: "click_add_to_cart",
      name: "42:81",
      properties: { product_id: "42", variant_id: "81", quantity: 3 },
    });
    analytics.trackAnalyticsEvent({
      category: "ecommerce",
      action: "update_quantity",
      properties: { product_id: "42", quantity: 5 },
    });
    analytics.trackAnalyticsEvent({
      category: "ecommerce",
      action: "view_item_list",
      properties: { placement: "plp", result_count: 24 },
    });
    expect(track).toHaveBeenCalledWith(
      "click_add_to_cart",
      expect.objectContaining({ quantity: 3, variant_id: "81" }),
    );
    expect(track).toHaveBeenCalledWith(
      "update_quantity",
      expect.objectContaining({ quantity: 5 }),
    );
    expect(track).toHaveBeenCalledWith(
      "view_item_list",
      expect.objectContaining({ result_count: 24 }),
    );
  });

  it("never lets the generic helpers emit guarded outcome events or revenue", async () => {
    const analytics = await import("../index");
    analytics.trackAnalyticsEvent({ category: "funnel", action: "purchase" });
    analytics.trackAnalyticsEvent({ category: "checkout", action: "payment_failed" });
    analytics.trackAnalyticsEvent({ category: "checkout", action: "error", name: "raw failure" });
    analytics.track("purchase", {});
    expect(track).not.toHaveBeenCalled();

    analytics.trackAnalyticsEvent({
      category: "funnel",
      action: "add_to_cart",
      properties: { product_id: "42", revenue: 5_000 } as never,
    });
    expect(track).toHaveBeenCalledWith("add_to_cart", { product_id: "42" });
  });

  it("emits purchase once per order with IRR revenue and a long order id intact", async () => {
    const analytics = await import("../index");
    expect(analytics.trackPurchase({ orderId: 12_345_678, revenueIrr: 21_490_000, gateway: "snappay" })).toBe(
      true,
    );
    expect(analytics.trackPurchase({ orderId: 12_345_678, revenueIrr: 21_490_000, gateway: "snappay" })).toBe(
      false,
    );
    expect(track.mock.calls).toEqual([
      [
        "purchase",
        { transaction_id: "12345678", revenue: 21_490_000, currency: "IRR", gateway: "snappay" },
      ],
    ]);

    // A reload loses the in-memory guard; the browser claim still holds.
    jest.resetModules();
    const reloaded = await import("../index");
    expect(reloaded.trackPurchase({ orderId: 12_345_678, revenueIrr: 21_490_000 })).toBe(false);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("rejects a purchase without a positive amount or a valid order id", async () => {
    const analytics = await import("../index");
    expect(analytics.trackPurchase({ orderId: 7, revenueIrr: 0 })).toBe(false);
    expect(analytics.trackPurchase({ orderId: "abc", revenueIrr: 10 })).toBe(false);
    expect(analytics.trackPurchase({ orderId: 7, revenueIrr: 10.5 })).toBe(false);
    expect(track).not.toHaveBeenCalled();
  });

  it("still emits purchase once when browser storage throws", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const analytics = await import("../index");
    expect(analytics.trackPurchase({ orderId: 9, revenueIrr: 100 })).toBe(true);
    expect(analytics.trackPurchase({ orderId: 9, revenueIrr: 100 })).toBe(false);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and never throws, when analytics is blocked", async () => {
    delete window.umami;
    const analytics = await import("../index");
    expect(() => analytics.trackPurchase({ orderId: 10, revenueIrr: 100 })).not.toThrow();
    expect(() =>
      analytics.trackAnalyticsEvent({ category: "funnel", action: "add_to_cart" }),
    ).not.toThrow();
    // Queued, bounded, and flushed only if the tracker ever loads.
    expect(window.__analyticsPendingCalls?.length).toBe(2);
  });

  it("reports payment outcomes once per order and attempt with stable categories", async () => {
    const analytics = await import("../index");
    analytics.trackPaymentOutcome("payment_failed", {
      orderId: 5,
      attemptKey: "a-1",
      gateway: "samankish",
      failureCategory: "gateway_failed",
    });
    analytics.trackPaymentOutcome("payment_failed", {
      orderId: 5,
      attemptKey: "a-1",
      gateway: "samankish",
      failureCategory: "gateway_failed",
    });
    analytics.trackPaymentOutcome("payment_failed", {
      orderId: 5,
      attemptKey: "a-2",
      gateway: "samankish",
      failureCategory: "expired",
    });
    expect(track.mock.calls).toEqual([
      ["payment_failed", { transaction_id: "5", gateway: "samankish", failure_category: "gateway_failed" }],
      ["payment_failed", { transaction_id: "5", gateway: "samankish", failure_category: "expired" }],
    ]);
  });

  it("maps checkout failures to a small category set", async () => {
    const analytics = await import("../index");
    expect(analytics.checkoutFailureCategoryForCode("STOCK_CHANGED")).toBe("stock_changed");
    expect(analytics.checkoutFailureCategoryForCode("snappay_unavailable")).toBe("gateway_unavailable");
    expect(analytics.checkoutFailureCategoryForCode("CART_EMPTY")).toBe("empty_cart");
    expect(analytics.checkoutFailureCategoryForCode("SOMETHING_NEW")).toBe("finalize_failed");
    expect(analytics.checkoutFailureCategoryForCode(undefined)).toBe("unknown");
    analytics.trackCheckoutFailure("quote_changed", "mellat");
    expect(track).toHaveBeenCalledWith("checkout_error", {
      failure_category: "quote_changed",
      gateway: "mellat",
    });
  });

  it("never sends a raw search query", async () => {
    const analytics = await import("../index");
    analytics.trackSiteSearch("کفش", "desktop", 0);
    expect(track).toHaveBeenCalledWith(
      "site_search",
      expect.objectContaining({
        surface: "desktop",
        result_count: 0,
        zero_results: true,
      }),
    );
    track.mockClear();
    analytics.trackSiteSearch("شماره 09123456789", "desktop", 0);
    expect(track).not.toHaveBeenCalled();
  });

  it("groups sensitive URLs and retains only validated UTM parameters", async () => {
    const analytics = await import("../index");
    expect(
      analytics.sanitizeAnalyticsUrl(
        "https://infinitycolor.co/orders/success?order=991&utm_source=instagram&phone=0912#receipt",
      ),
    ).toBe("/orders/:state?utm_source=instagram");
    expect(
      analytics.sanitizeAnalyticsUrl(
        "https://infinitycolor.co/search/09123456789?utm_campaign=09123456789",
      ),
    ).toBe("/search/redacted");
  });

  it("does not leak a raw search query through a document title", async () => {
    const analytics = await import("../index");
    analytics.trackPage({
      url: "https://infinitycolor.co/plp?search=red+shoes",
      title: "نتایج جستجو: red shoes",
    });
    const page = track.mock.calls.find(([input]) => typeof input === "function")?.[0] as
      | ((defaults: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    expect(page?.({ url: "/default" })).toEqual({ url: "/plp" });
  });

  it("keeps only allowlisted performance fields for every visitor", async () => {
    const analytics = await import("../index");
    expect(
      analytics.analyticsBeforeSend("performance", {
        url: "https://infinitycolor.co/orders/123?token=secret",
        id: "712",
        lcp: 120,
        rawTiming: "secret",
      }),
    ).toEqual({ url: "/orders/:state", id: "712", lcp: 120 });
  });

  it("identifies a signed-in customer once and never identifies a guest", async () => {
    const analytics = await import("../index");
    analytics.identify(712);
    analytics.identify("712");
    expect(identify.mock.calls).toEqual([["712"]]);
    analytics.resetIdentity();
    expect(identify).toHaveBeenCalledTimes(1);
    analytics.identify(712);
    expect(identify).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(identify.mock.calls)).not.toContain("guest-");
  });

  it("keeps the checkout correlation value in memory without browser storage", async () => {
    const analytics = await import("../index");
    const first = analytics.getAnalyticsCorrelationId();
    expect(analytics.getAnalyticsCorrelationId()).toBe(first);
    expect(first).toMatch(/^guest-/);
    expect(window.localStorage.length).toBe(0);
    expect(identify).not.toHaveBeenCalled();
  });

  it("deduplicates event calls guarded by the same once key", async () => {
    const analytics = await import("../index");
    analytics.trackAnalyticsEvent({ category: "funnel", action: "begin_checkout", onceKey: "one" });
    analytics.trackAnalyticsEvent({ category: "funnel", action: "begin_checkout", onceKey: "one" });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("exposes the typed event interface and converts Toman to IRR", async () => {
    const analytics = await import("../index");
    analytics.track("add_to_cart", {
      productId: 42,
      variantId: 81,
      quantity: 2,
      valueToman: 125_000,
    });
    expect(track).toHaveBeenCalledWith("add_to_cart", {
      product_id: "42",
      variant_id: "81",
      quantity: 2,
      value_irr: 1_250_000,
      currency: "IRR",
    });
  });

  it("never sends coupon codes", async () => {
    const analytics = await import("../index");
    analytics.trackAnalyticsEvent({
      category: "ecommerce",
      action: "apply_coupon",
      name: "PRIVATE-CODE",
      valueToman: 10_000,
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain("PRIVATE-CODE");
  });
});
