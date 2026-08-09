import {
  getUmamiClient,
  getUmamiConfig,
  getUmamiRealtimeReport,
  isUmamiConfigured,
  normalizeUmamiFilters,
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
});
