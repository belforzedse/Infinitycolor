import {
  __private,
  conversionTrendBuckets,
  getUmamiBehaviorReport,
  getUmamiConversionDetail,
  getUmamiClient,
  getUmamiConfig,
  getUmamiRealtimeReport,
  isUmamiConfigured,
  normalizeUmamiFilters,
  parseConversionDetail,
  stepFilterScope,
  UMAMI_FUNNELS,
} from "../umami";

describe("Umami client", () => {
  const websiteId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env.UMAMI_BASE_URL = "https://analytics.example.test";
    process.env.UMAMI_WEBSITE_ID = websiteId;
    process.env.UMAMI_WEBSITE_ALLOWLIST = websiteId;
    process.env.UMAMI_API_TOKEN = "a-static-api-token";
    process.env.UMAMI_TIMEOUT_MS = "100";
  });

  afterEach(() => {
    delete process.env.UMAMI_BASE_URL;
    delete process.env.UMAMI_WEBSITE_ID;
    delete process.env.UMAMI_WEBSITE_ALLOWLIST;
    delete process.env.UMAMI_API_TOKEN;
  });

  it("fails closed unless the website id is explicitly allowlisted", () => {
    expect(isUmamiConfigured()).toBe(true);
    expect(getUmamiConfig().websiteAllowlist.has(websiteId)).toBe(true);
    process.env.UMAMI_WEBSITE_ALLOWLIST = "22222222-2222-4222-8222-222222222222";
    expect(isUmamiConfigured()).toBe(false);
    expect(getUmamiClient().isWebsiteAllowed("not-allowlisted")).toBe(false);
  });

  it("accepts only an exact HTTPS origin, with loopback HTTP reserved for local use", () => {
    expect(
      getUmamiConfig({
        ...process.env,
        UMAMI_BASE_URL: "https://analytics.example.test/private",
      }).baseUrl,
    ).toBe("");
    expect(
      getUmamiConfig({
        ...process.env,
        UMAMI_BASE_URL: "http://analytics.example.test",
      }).baseUrl,
    ).toBe("");
    expect(
      getUmamiConfig({
        ...process.env,
        UMAMI_BASE_URL: "http://127.0.0.1:8093",
      }).baseUrl,
    ).toBe("http://127.0.0.1:8093");
  });

  it("uses the Umami 3.2 stats endpoint and bearer token", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ pageviews: 12, visitors: 8 }),
    } as Response);

    await getUmamiClient().statistics({ startDate: "2026-08-01", endDate: "2026-08-01" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/websites/${websiteId}/stats`);
    expect((init?.headers as Headers).get("authorization")).toBe("Bearer a-static-api-token");
  });

  it("requires a successful collector response shape", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          cache: "collector-token",
          sessionId: "session-id",
          visitId: "visit-id",
        }),
    } as Response);

    await expect(
      getUmamiClient().sendEvent({
        type: "event",
        payload: { website: websiteId, url: "/", name: "purchase" },
      }),
    ).resolves.toMatchObject({ sessionId: "session-id", visitId: "visit-id" });
  });

  it("validates stable product filters and sends them only to the event-data pivot", async () => {
    expect(
      normalizeUmamiFilters({
        productId: "123",
        categoryId: "summer-2026",
        variantId: "customer@example.test",
        ignored: "secret",
      }),
    ).toEqual({ productId: "123", categoryId: "summer-2026" });
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [], count: 0 }),
    } as Response);

    await getUmamiClient().eventDataPivot(
      "view_item",
      { startDate: "2026-08-01", endDate: "2026-08-02" },
      { pf_product_id: "1.eq.123" },
      { country: "IR", productId: "123" },
    );

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toContain(`/api/websites/${websiteId}/event-data-pivot`);
    expect(url.searchParams.get("eventName")).toBe("view_item");
    expect(url.searchParams.get("pf_product_id")).toBe("1.eq.123");
    expect(url.searchParams.get("country")).toBe("IR");
    expect(url.searchParams.has("productId")).toBe(false);
  });

  it("omits false exclude-bounce filters because Umami treats any supplied string as true", () => {
    expect(normalizeUmamiFilters({ excludeBounce: "false" })).toEqual({});
    expect(normalizeUmamiFilters({ excludeBounce: "0" })).toEqual({});
    expect(normalizeUmamiFilters({ excludeBounce: "true" })).toEqual({
      excludeBounce: "true",
    });
  });

  it("returns only purpose-shaped realtime aggregates with unique sessions per path", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          totals: { visitors: 3 },
          urls: { "/pdp/red": 4 },
          events: [
            { sessionId: "session-a", urlPath: "/pdp/red" },
            { sessionId: "session-a", urlPath: "/pdp/red" },
            { sessionId: "session-b", urlPath: "/pdp/red" },
            { sessionId: "session-c", urlPath: "/plp" },
          ],
          countries: { IR: 3 },
        }),
    } as Response);

    await expect(getUmamiRealtimeReport()).resolves.toEqual({
      activeVisitors: 3,
      topPages: [
        { path: "/pdp/red", visitors: 2 },
        { path: "/plp", visitors: 1 },
      ],
    });
  });

  it("rejects bot-filter responses instead of marking an outbox row sent", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ beep: "boop" }),
    } as Response);

    await expect(
      getUmamiClient().sendEvent({
        type: "event",
        payload: { website: websiteId, url: "/commerce/purchase", name: "purchase" },
      }),
    ).rejects.toThrow("UMAMI_COLLECTOR_REJECTED");
  });

  it("never shows the backend's diagnostic session as a live visitor", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          totals: { visitors: 2 },
          events: [
            { sessionId: "shopper", urlPath: "/pdp/red" },
            { sessionId: "backend", urlPath: "/commerce/order_paid", eventName: "order_paid" },
            { sessionId: "backend", urlPath: "/commerce/refund", eventName: "refund" },
          ],
        }),
    } as Response);

    await expect(getUmamiRealtimeReport()).resolves.toEqual({
      activeVisitors: 1,
      topPages: [{ path: "/pdp/red", visitors: 1 }],
    });
  });

  it("keeps missing metric values null and gives event tables event columns", () => {
    expect(
      __private.metricRows([{ name: "/plp", pageviews: "12", visitors: 5 }], "path"),
    ).toEqual([{ label: "/plp", pageviews: 12, visitors: 5 }]);
    expect(
      __private.metricRows(
        [{ name: "purchase", pageviews: "7", visitors: 6, visits: 6, bounces: 0, totaltime: 9 }],
        "event",
      ),
    ).toEqual([{ label: "purchase", count: 7, visitors: 6, visits: 6 }]);
  });

  it("reads Umami's grouped UTM and attribution shapes", () => {
    expect(
      __private.utmGroups({ utm_source: [{ utm: "instagram", views: 9 }], utm_term: [] }),
    ).toEqual({
      utm_source: [{ label: "instagram", value: 9 }],
      utm_medium: [],
      utm_campaign: [],
      utm_content: [],
      utm_term: [],
    });
    expect(
      __private.attributionGroups({
        referrer: [{ name: "instagram.com", value: 4 }],
        paidAds: [],
        utm_source: [{ name: "story", value: 2 }],
        total: { pageviews: 10, visitors: 6, visits: 7 },
      }),
    ).toEqual({
      referrer: [{ label: "instagram.com", value: 4 }],
      paidAds: [],
      utm_source: [{ label: "story", value: 2 }],
      utm_medium: [],
      utm_campaign: [],
      total: { visitors: 6, visits: 7 },
    });
  });

  it("drops journeys that pass through a server diagnostic", () => {
    expect(
      __private.visitorJourneys([
        { e1: "/plp", e2: "view_item", e3: "add_to_cart", count: 5 },
        { e1: "order_paid", e2: "order_paid", count: 90 },
        { e1: "/commerce/purchase", count: 40 },
      ]),
    ).toEqual([{ e1: "/plp", e2: "view_item", e3: "add_to_cart", count: 5 }]);
  });

  function recordProvider(respond: (path: string, body: any, url: URL) => unknown) {
    const calls: Array<{ path: string; body: any; url: URL }> = [];
    jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: url.pathname, body, url });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(respond(url.pathname, body, url)),
      } as Response;
    });
    return calls;
  }

  const funnelResponse = (steps: readonly string[], counts: number[]) =>
    steps.map((value, index) => ({
      type: "event",
      value,
      visitors: counts[index],
      previous: index ? counts[index - 1] : 0,
      dropped: index ? counts[index - 1] - counts[index] : 0,
      // Umami computes step 1's drop-off as 1 - n/0; JSON turns -Infinity into null.
      dropoff: index ? 1 - counts[index] / counts[index - 1] : null,
      remaining: counts[index] / counts[0],
    }));

  it("runs the end-to-end funnel once and derives the three-step discovery funnel from it", async () => {
    const coreCounts = [1000, 130, 46, 37, 31, 25];
    const calls = recordProvider((path, body) => {
      if (path === "/api/reports/goal") return { num: 25, total: 1800 };
      if (path === "/api/reports/funnel") {
        const steps = body.parameters.steps.map((step: any) => step.value);
        return funnelResponse(steps, steps.length === 6 ? coreCounts : steps.map(() => 5));
      }
      if (path.includes("/stats")) return { pageviews: 10, visitors: 5, visits: 6, bounces: 2, totaltime: 60 };
      return [];
    });

    const report = await getUmamiBehaviorReport(
      "conversion",
      { startDate: "2026-09-15", endDate: "2026-09-20" },
      { filters: { event: "view_item", device: "mobile", utmSource: "instagram", path: "/plp" } },
    );

    const funnels = calls.filter((call) => call.path === "/api/reports/funnel");
    expect(funnels.map((call) => call.body.parameters.steps.map((step: any) => step.value))).toEqual(
      expect.arrayContaining([
        [...UMAMI_FUNNELS.core.steps],
        [...UMAMI_FUNNELS.checkout.steps],
        [...UMAMI_FUNNELS.payment.steps],
      ]),
    );
    expect(funnels).toHaveLength(3);
    // Only session-level filters can narrow an ordered funnel; event-level ones
    // (UTM, path, event) would have to match every step's own row.
    for (const call of funnels) expect(call.body.filters).toEqual({ device: "mobile" });
    // One goal for the segment, one unfiltered for reconciling with the orders ledger.
    expect(
      calls.filter((c) => c.path === "/api/reports/goal").map((c) => c.body.filters),
    ).toEqual(expect.arrayContaining([{ device: "mobile" }, {}]));
    expect(report.sections.purchaseGoalAll).toEqual({ num: 25, total: 1800 });
    expect(report.sections.stepFilters).toEqual({
      applied: ["device"],
      ignored: ["event", "path", "utmSource"],
    });
    expect(report.sections.funnelDefinitions).toBe(UMAMI_FUNNELS);
    expect(report.sections.purchaseGoal).toEqual({ num: 25, total: 1800 });
    const core = report.sections.coreFunnel as any[];
    expect(core[0]).toEqual({
      type: "event",
      value: "view_item",
      visitors: 1000,
      previous: 0,
      dropped: 0,
      remaining: 1,
    });
    expect(core[5]).toMatchObject({ value: "purchase", visitors: 25, previous: 31, dropped: 6 });
    expect(report.sections.discoveryFunnel).toEqual(core.slice(0, 3));
  });

  it("classifies filters by whether Umami keeps them on the session", () => {
    expect(stepFilterScope({ os: "iOS", tag: "release:1", hostname: "x", match: "any" })).toEqual({
      applied: { os: "iOS", match: "any" },
      ignored: ["hostname", "tag"],
    });
    expect(stepFilterScope({ match: "all", referrer: "instagram.com" })).toEqual({
      applied: {},
      ignored: ["referrer"],
    });
  });

  it("asks for a Tehran-bucketed pageview series and marks empty buckets as no data", async () => {
    process.env.UMAMI_DATA_START_DATE = "2026-08-10";
    const calls = recordProvider((path) => {
      if (path.endsWith("/pageviews")) {
        return {
          pageviews: [
            { x: "2026-08-09 00:00:00", y: 4 },
            { x: "2026-08-10 00:00:00", y: 40 },
            { x: "2026-08-12 00:00:00", y: 0 },
          ],
          sessions: [{ x: "2026-08-10 00:00:00", y: 12 }],
        };
      }
      if (path.includes("/stats")) return { pageviews: 44, visitors: 12, visits: 13 };
      return [];
    });

    const report = await getUmamiBehaviorReport("overview", {
      startDate: "2026-08-09",
      endDate: "2026-08-12",
    });
    delete process.env.UMAMI_DATA_START_DATE;

    const series = calls.find((call) => call.path.endsWith("/pageviews"))!;
    expect(series.url.searchParams.get("unit")).toBe("day");
    expect(series.url.searchParams.get("timezone")).toBe("Asia/Tehran");
    expect(report.sections.trend).toEqual({
      unit: "day",
      points: [
        // Before the data-start date: no data, even though Umami sent a count.
        { t: "2026-08-09", pageviews: null, visitors: null },
        { t: "2026-08-10", pageviews: 40, visitors: 12 },
        // Nothing recorded at all is not a zero-traffic day.
        { t: "2026-08-11", pageviews: null, visitors: null },
        { t: "2026-08-12", pageviews: 0, visitors: null },
      ],
    });
  });

  it("keeps server diagnostics out of the visitor event table", () => {
    expect(
      __private
        .metricRows(
          [
            { name: "add_to_cart", pageviews: 9, visitors: 4 },
            { name: "order_paid", pageviews: 30, visitors: 1 },
            { name: "refund", pageviews: 2, visitors: 1 },
          ],
          "event",
        )
        .map((row) => row.label),
    ).toEqual(["add_to_cart"]);
  });

  it("buckets the conversion trend daily, weekly, then into at most twelve spans", () => {
    expect(conversionTrendBuckets({ startDate: "2026-09-01", endDate: "2026-09-10" }, "2026-09-30")).toHaveLength(10);
    const weekly = conversionTrendBuckets(
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      "2026-09-30",
    );
    expect(weekly.map((bucket) => [bucket.startDate, bucket.endDate, bucket.incomplete])).toEqual([
      ["2026-09-01", "2026-09-07", false],
      ["2026-09-08", "2026-09-14", false],
      ["2026-09-15", "2026-09-21", false],
      ["2026-09-22", "2026-09-28", false],
      // Shorter than its siblings and still open today.
      ["2026-09-29", "2026-09-30", true],
    ]);
    const long = conversionTrendBuckets({ startDate: "2026-01-01", endDate: "2026-07-19" }, "2026-09-30");
    expect(long.length).toBeLessThanOrEqual(12);
    expect(long[0].days).toBe(17);
  });

  it("accepts only allowlisted drill-downs", () => {
    expect(parseConversionDetail({})).toBeNull();
    expect(parseConversionDetail({ detail: "trend" })).toEqual({ detail: "trend", funnel: "core" });
    expect(parseConversionDetail({ detail: "journey", step: "add_to_cart" })).toEqual({
      detail: "journey",
      step: "add_to_cart",
    });
    for (const query of [
      { detail: "trend", funnel: "discovery" },
      { detail: "breakdown", dimension: "utmSource" },
      { detail: "journey", step: "/admin" },
      { detail: "raw" },
    ]) {
      expect(() => parseConversionDetail(query)).toThrow("INVALID_CONVERSION_DETAIL");
    }
  });

  it("runs one funnel per trend bucket and skips buckets before the data-start date", async () => {
    const calls = recordProvider((path, body) => {
      if (path === "/api/reports/goal") return { num: 2, total: 50 };
      if (path === "/api/reports/funnel") {
        return funnelResponse(
          body.parameters.steps.map((step: any) => step.value),
          [50, 10, 4, 3, 3, 2],
        );
      }
      return [];
    });

    const report = await getUmamiConversionDetail(
      { detail: "trend", funnel: "core" },
      { startDate: "2026-08-06", endDate: "2026-08-10" },
      { filters: { device: "mobile", utmCampaign: "autumn" } },
    );

    const buckets = report.sections.buckets as any[];
    expect(buckets.map((bucket) => bucket.startDate)).toEqual([
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
    ]);
    expect(buckets.slice(0, 3).every((bucket) => bucket.beforeDataStart)).toBe(true);
    expect(buckets[3].steps).toHaveLength(6);
    expect(buckets[3].purchaseGoal).toEqual({ num: 2, total: 50 });
    expect(calls.filter((call) => call.path === "/api/reports/funnel")).toHaveLength(2);
    expect(calls.every((call) => !call.body || JSON.stringify(call.body.filters) === '{"device":"mobile"}')).toBe(true);
    expect(report.errors).toEqual({});
  });

  it("breaks a funnel down by the top segments of a session-level dimension", async () => {
    const calls = recordProvider((path, body) => {
      if (path.includes("/metrics/expanded")) {
        return [
          { name: "Android", visitors: 900 },
          { name: "", visitors: 40 },
          { name: "iOS", visitors: 300 },
        ];
      }
      if (path === "/api/reports/funnel") {
        return funnelResponse(
          body.parameters.steps.map((step: any) => step.value),
          body.filters.os === "iOS" ? [300, 90, 60, 50] : [900, 180, 90, 60],
        );
      }
      return [];
    });

    const report = await getUmamiConversionDetail(
      { detail: "breakdown", funnel: "checkout", dimension: "os" },
      { startDate: "2026-09-15", endDate: "2026-09-20" },
    );

    const metricCall = calls.find((call) => call.path.includes("/metrics/expanded"))!;
    expect(metricCall.url.searchParams.get("type")).toBe("os");
    expect((report.sections.segments as any[]).map((segment) => [segment.value, segment.visitors])).toEqual([
      ["Android", 900],
      ["iOS", 300],
    ]);
    expect(
      calls.filter((call) => call.path === "/api/reports/funnel").map((call) => call.body.filters),
    ).toEqual([{ os: "Android" }, { os: "iOS" }]);
  });
});
