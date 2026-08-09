describe("provider-neutral storefront analytics", () => {
  const track = jest.fn();
  const identify = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.umami = { track, identify } as NonNullable<Window["umami"]>;
    delete window.__analyticsPendingCalls;
    process.env.NEXT_PUBLIC_UMAMI_ENABLE_DEV = "true";
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "0" });
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

  it("sends basic event names without enriched properties by default", async () => {
    const analytics = await import("../index");
    analytics.trackAnalyticsEvent({
      category: "funnel",
      action: "add_to_cart",
      name: "42:عنوان محصول",
      value: 125_000,
    });
    expect(track).toHaveBeenCalledWith("add_to_cart", undefined);
  });

  it("adds only allowlisted stable properties after explicit consent", async () => {
    const analytics = await import("../index");
    analytics.setAnalyticsConsent("granted");
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
  });

  it("drops unknown event properties and never emits the server-owned purchase", async () => {
    const analytics = await import("../index");
    analytics.setAnalyticsConsent("granted");
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

    analytics.track({ category: "funnel", action: "purchase" });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("treats DNT as basic even after consent and suppresses performance payloads", async () => {
    const analytics = await import("../index");
    analytics.setAnalyticsConsent("granted");
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
    expect(analytics.getAnalyticsTier()).toBe("basic");
    expect(analytics.analyticsBeforeSend("performance", { url: "/", lcp: 100 })).toBeNull();
  });

  it("never sends a raw search query", async () => {
    const analytics = await import("../index");
    analytics.setAnalyticsConsent("granted");
    analytics.trackSiteSearch("کفش", "desktop", 0);
    const serialized = JSON.stringify(track.mock.calls);
    expect(serialized).not.toContain("09123456789");
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

  it("keeps only allowlisted performance fields after explicit consent", async () => {
    const analytics = await import("../index");
    analytics.setAnalyticsConsent("granted");
    expect(
      analytics.analyticsBeforeSend("performance", {
        url: "https://infinitycolor.co/orders/123?token=secret",
        id: "712",
        lcp: 120,
        rawTiming: "secret",
      }),
    ).toEqual({ url: "/orders/:state", id: "712", lcp: 120 });
  });

  it("exposes typed session properties only after explicit consent", async () => {
    const analytics = await import("../index");
    analytics.setSessionProperties({
      route_group: "pdp",
      category_id: "shirts",
      unexpected: "drop-me",
    } as never);
    expect(identify).not.toHaveBeenCalled();
    analytics.setAnalyticsConsent("granted");
    analytics.setSessionProperties({ route_group: "pdp", category_id: "shirts" });
    expect(identify).toHaveBeenCalledWith({ route_group: "pdp", category_id: "shirts" });
  });

  it("identifies a signed-in customer with the raw internal id even without consent", async () => {
    const analytics = await import("../index");
    analytics.setAnalyticsConsent("denied");
    analytics.identify(712);
    expect(identify).toHaveBeenCalledWith("712");
  });

  it("keeps guest correlation in memory without browser storage", async () => {
    const analytics = await import("../index");
    const first = analytics.getAnalyticsCorrelationId();
    const second = analytics.getAnalyticsCorrelationId();
    expect(first).toBe(second);
    expect(first).toMatch(/^guest-/);
    expect(window.localStorage.getItem("analytics-correlation-id")).toBeNull();
  });

  it("deduplicates event calls guarded by the same once key", async () => {
    const analytics = await import("../index");
    analytics.trackAnalyticsEvent({ category: "funnel", action: "begin_checkout", onceKey: "one" });
    analytics.trackAnalyticsEvent({ category: "funnel", action: "begin_checkout", onceKey: "one" });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("exposes the typed event interface and converts Toman to IRR", async () => {
    const analytics = await import("../index");
    analytics.setAnalyticsConsent("granted");
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

  it("never sends coupon codes or error strings", async () => {
    const analytics = await import("../index");
    analytics.setAnalyticsConsent("granted");
    analytics.trackAnalyticsEvent({
      category: "ecommerce",
      action: "apply_coupon",
      name: "PRIVATE-CODE",
      valueToman: 10_000,
    });
    analytics.trackAnalyticsEvent({
      category: "checkout",
      action: "error",
      name: "raw provider failure",
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain("PRIVATE-CODE");
    expect(JSON.stringify(track.mock.calls)).not.toContain("raw provider failure");
  });
});
