import {
  __private,
  getUmamiBehaviorReport,
  getUmamiClient,
  getUmamiConfig,
  getUmamiRealtimeReport,
  isUmamiConfigured,
  normalizeUmamiFilters,
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

  it("runs the shared funnels without the report-level event filter", async () => {
    const bodies: Array<{ path: string; body: any }> = [];
    jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      bodies.push({ path: url.pathname, body });
      const payload = url.pathname.startsWith("/api/reports/")
        ? url.pathname.endsWith("goal")
          ? { num: 3, total: 90 }
          : []
        : url.pathname.includes("/stats")
          ? { pageviews: 10, visitors: 5, visits: 6, bounces: 2, totaltime: 60 }
          : [];
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as Response;
    });

    const report = await getUmamiBehaviorReport(
      "conversion",
      { startDate: "2026-09-15", endDate: "2026-09-20" },
      { filters: { event: "view_item", device: "mobile" } },
    );

    const funnels = bodies.filter((call) => call.path === "/api/reports/funnel");
    expect(funnels.map((call) => call.body.parameters)).toEqual(
      expect.arrayContaining(
        Object.values(UMAMI_FUNNELS).map((definition) =>
          expect.objectContaining({
            window: definition.window,
            steps: definition.steps.map((value) => ({ type: "event", value })),
          }),
        ),
      ),
    );
    for (const call of [...funnels, ...bodies.filter((c) => c.path === "/api/reports/goal")]) {
      expect(call.body.filters).toEqual({ device: "mobile" });
    }
    expect(report.sections.funnelDefinitions).toBe(UMAMI_FUNNELS);
    expect(report.sections.purchaseGoal).toEqual({ num: 3, total: 90 });
  });
});
