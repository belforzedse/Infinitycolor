import {
  getMatomoEcommerceSummary,
  getMatomoFunnel,
  getMatomoRealtimePayload,
  getMatomoTrafficDashboardPayload,
  getMatomoVisitsSummary,
  normalizeRange,
} from "../matomo";

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
};

function mockJsonResponse(payload: any, status = 200): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function installMatomoEnv() {
  process.env.MATOMO_BASE_URL = "https://matomo.example.com";
  process.env.MATOMO_SITE_ID = "1";
  process.env.MATOMO_API_TOKEN = "test-token";
  process.env.MATOMO_TIMEOUT_MS = "100";
}

describe("Matomo report service", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    installMatomoEnv();
  });

  it("normalizes date ranges and rejects invalid date order", () => {
    const range = normalizeRange("2026-01-01", "2026-01-31");
    expect(range).toEqual({ startDate: "2026-01-01", endDate: "2026-01-31" });

    expect(() => normalizeRange("2026-01-31", "2026-01-01")).toThrow("INVALID_DATE_RANGE");
    expect(() => normalizeRange("invalid", "2026-01-01")).toThrow("INVALID_DATE_RANGE");
  });

  it("fails with MATOMO_AUTH_FAILED when token is invalid", async () => {
    jest.spyOn(global, "fetch" as any).mockResolvedValue(
      mockJsonResponse({ result: "error", message: "Invalid token_auth" }) as any,
    );

    await expect(getMatomoRealtimePayload()).rejects.toThrow("MATOMO_AUTH_FAILED");
  });

  it("fails with MATOMO_TIMEOUT on request timeout", async () => {
    process.env.MATOMO_TIMEOUT_MS = "10";
    jest.spyOn(global, "fetch" as any).mockImplementation((_: string, init?: RequestInit) => {
      return new Promise((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const err = new Error("Request aborted");
          (err as any).name = "AbortError";
          reject(err);
        });
      });
    });

    await expect(getMatomoRealtimePayload()).rejects.toThrow("MATOMO_TIMEOUT");
  });

  it("returns a normalized dashboard payload contract", async () => {
    jest.spyOn(global, "fetch" as any).mockImplementation(async (url: string) => {
      const requestUrl = new URL(url);
      const method = requestUrl.searchParams.get("method");

      switch (method) {
        case "VisitsSummary.get": {
          if (requestUrl.searchParams.get("period") === "day") {
            return mockJsonResponse({
              "2026-01-01": { nb_visits: 12, nb_uniq_visitors: 10, nb_actions: 23 },
              "2026-01-02": { nb_visits: 15, nb_uniq_visitors: 11, nb_actions: 30 },
            }) as any;
          }
          return mockJsonResponse({
            nb_visits: 100,
            nb_uniq_visitors: 70,
            nb_actions: 250,
            bounce_rate: "25%",
            nb_actions_per_visit: 2.5,
            avg_time_on_site: 120,
          }) as any;
        }
        case "Live.getCounters":
          return mockJsonResponse({ visits: requestUrl.searchParams.get("lastMinutes") === "5" ? 3 : 12 }) as any;
        case "Live.getLastVisitsDetails":
          return mockJsonResponse([
            { actionDetails: [{ type: "action", url: "/pdp/item-1" }] },
            { actionDetails: [{ type: "action", url: "/pdp/item-1" }] },
            { actionDetails: [{ type: "action", url: "/plp" }] },
          ]) as any;
        case "Referrers.getWebsites":
          return mockJsonResponse([{ label: "google", nb_visits: 40, nb_uniq_visitors: 25 }]) as any;
        case "Referrers.getCampaigns":
          return mockJsonResponse([
            { label: "winter_sale", nb_visits: 12, nb_uniq_visitors: 9 },
            { label: "javascript:domxss", nb_visits: 2, nb_uniq_visitors: 0 },
            { label: "{{template_probe}}", nb_visits: 1, nb_uniq_visitors: 0 },
          ]) as any;
        case "Actions.getPageUrls":
          return mockJsonResponse([{ label: "/pdp/item-1", nb_hits: 44, nb_visits: 31 }]) as any;
        case "Actions.getEntryPageUrls":
          return mockJsonResponse([{ label: "/pdp/item-1", entry_nb_visits: 11, bounce_rate: "20%" }]) as any;
        case "Actions.getExitPageUrls":
          return mockJsonResponse([{ label: "/checkout", exit_nb_visits: 4, exit_rate: "13.3%" }]) as any;
        case "Events.getAction":
          return mockJsonResponse([
            // nb_events > nb_visits on add_to_cart simulates a visit firing the
            // event twice (e.g. quantity bump) — the funnel must count the visit
            // once, not the event twice.
            { label: "view_item", nb_events: 130, nb_visits: 120 },
            { label: "add_to_cart", nb_events: 80, nb_visits: 50 },
            { label: "begin_checkout", nb_events: 20, nb_visits: 20 },
            { label: "purchase", nb_events: 10, nb_visits: 10 },
          ]) as any;
        case "DevicesDetection.getType":
          return mockJsonResponse([{ label: "Desktop", nb_visits: 55 }]) as any;
        case "UserCountry.getCountry":
          return mockJsonResponse([{ label: "Iran", nb_visits: 80 }]) as any;
        default:
          return mockJsonResponse({}) as any;
      }
    });

    const payload = await getMatomoTrafficDashboardPayload({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });

    expect(payload.summary.visits).toBe(100);
    expect(payload.realtime.activeVisitorsLast5Min).toBe(3);
    expect(payload.series).toHaveLength(2);
    expect(payload.acquisition.sources[0].source).toBe("google");
    expect(payload.acquisition.campaigns).toEqual([
      { campaign: "winter_sale", visits: 12, visitors: 9 },
      { campaign: "Suspicious campaign blocked", visits: 3, visitors: 0 },
    ]);
    expect(payload.pages.top[0].url).toBe("/pdp/item-1");
    expect(payload.funnel.map((row) => row.step)).toEqual([
      "view_item",
      "add_to_cart",
      "begin_checkout",
      "purchase",
    ]);
    // Counted by nb_visits (visit-level reach), not nb_events — a visit that
    // fires add_to_cart twice must not inflate the step count.
    expect(payload.funnel.map((row) => row.count)).toEqual([120, 50, 20, 10]);
    expect(payload.deviceBreakdown[0].device).toBe("Desktop");
    expect(payload.geoBreakdown[0].country).toBe("Iran");
  });

  it("caps funnel conversionFromPrevious at 100% even if a later step's visit count exceeds the prior step's (step-reach, not a strict ordered funnel)", async () => {
    jest.spyOn(global, "fetch" as any).mockImplementation(async (url: string) => {
      const requestUrl = new URL(url);
      const method = requestUrl.searchParams.get("method");

      if (method === "Events.getAction") {
        return mockJsonResponse([
          { label: "view_item", nb_events: 10, nb_visits: 10 },
          { label: "add_to_cart", nb_events: 10, nb_visits: 10 },
          // More visits reach begin_checkout than were counted for add_to_cart
          // (e.g. a direct-checkout link) — a real, if unusual, step-reach case.
          { label: "begin_checkout", nb_events: 15, nb_visits: 15 },
          { label: "purchase", nb_events: 5, nb_visits: 5 },
        ]) as any;
      }
      if (method === "VisitsSummary.get") {
        return mockJsonResponse(
          requestUrl.searchParams.get("period") === "day"
            ? {}
            : { nb_visits: 0, nb_uniq_visitors: 0, nb_actions: 0, bounce_rate: "0%", nb_actions_per_visit: 0, avg_time_on_site: 0 },
        ) as any;
      }
      return mockJsonResponse([]) as any;
    });

    const payload = await getMatomoTrafficDashboardPayload({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });

    const beginCheckout = payload.funnel.find((row) => row.step === "begin_checkout");
    expect(beginCheckout?.count).toBe(15);
    expect(beginCheckout?.conversionFromPrevious).toBe(100);
  });

  it("uses latest page action per visit for realtime top pages", async () => {
    jest.spyOn(global, "fetch" as any).mockImplementation(async (url: string) => {
      const requestUrl = new URL(url);
      const method = requestUrl.searchParams.get("method");

      switch (method) {
        case "Live.getCounters":
          return mockJsonResponse({ visits: 1 }) as any;
        case "Live.getLastVisitsDetails":
          return mockJsonResponse([
            {
              actionDetails: [
                { type: "action", url: "/plp" },
                { type: "action", url: "/pdp/1" },
              ],
            },
            {
              actionDetails: [
                { type: "action", url: "/pdp/1" },
                { type: "action", url: "/checkout" },
              ],
            },
          ]) as any;
        default:
          return mockJsonResponse({}) as any;
      }
    });

    const payload = await getMatomoRealtimePayload();
    expect(payload.topPagesNow[0]).toEqual({ url: "/pdp/1", visits: 1 });
    expect(payload.topPagesNow[1]).toEqual({ url: "/checkout", visits: 1 });
  });

  describe("getMatomoEcommerceSummary", () => {
    it("returns orders and revenue from Goals.get(idGoal=ecommerceOrder)", async () => {
      jest.spyOn(global, "fetch" as any).mockImplementation(async (url: string) => {
        const requestUrl = new URL(url);
        expect(requestUrl.searchParams.get("method")).toBe("Goals.get");
        expect(requestUrl.searchParams.get("idGoal")).toBe("ecommerceOrder");
        return mockJsonResponse({ nb_conversions: 42, revenue: 4_500_000 }) as any;
      });

      const summary = await getMatomoEcommerceSummary({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(summary).toEqual({ orders: 42, revenue: 4_500_000 });
    });

    it("returns null when Matomo is not configured", async () => {
      delete process.env.MATOMO_BASE_URL;
      const summary = await getMatomoEcommerceSummary({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
      expect(summary).toBeNull();
    });

    it("returns null (never throws) on a Matomo error", async () => {
      jest.spyOn(global, "fetch" as any).mockResolvedValue(
        mockJsonResponse({ result: "error", message: "Invalid token_auth" }) as any,
      );
      const summary = await getMatomoEcommerceSummary({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
      expect(summary).toBeNull();
    });
  });

  describe("getMatomoVisitsSummary", () => {
    it("issues exactly one VisitsSummary.get call", async () => {
      const fetchSpy = jest.spyOn(global, "fetch" as any).mockImplementation(async (url: string) => {
        const requestUrl = new URL(url);
        expect(requestUrl.searchParams.get("method")).toBe("VisitsSummary.get");
        return mockJsonResponse({ nb_visits: 500, nb_uniq_visitors: 300, nb_actions: 1200 }) as any;
      });

      const summary = await getMatomoVisitsSummary({ startDate: "2026-01-01", endDate: "2026-01-31" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(summary).toEqual({ visits: 500, visitors: 300, pageviews: 1200 });
    });

    it("returns null when Matomo is not configured", async () => {
      delete process.env.MATOMO_BASE_URL;
      const summary = await getMatomoVisitsSummary({ startDate: "2026-01-01", endDate: "2026-01-31" });
      expect(summary).toBeNull();
    });

    it("returns null (never throws) on a Matomo error", async () => {
      jest.spyOn(global, "fetch" as any).mockResolvedValue(
        mockJsonResponse({ result: "error", message: "Invalid token_auth" }) as any,
      );
      const summary = await getMatomoVisitsSummary({ startDate: "2026-01-01", endDate: "2026-01-31" });
      expect(summary).toBeNull();
    });
  });

  describe("getMatomoFunnel", () => {
    it("issues exactly one Events.getAction call and returns the 4-step funnel", async () => {
      const fetchSpy = jest.spyOn(global, "fetch" as any).mockImplementation(async (url: string) => {
        const requestUrl = new URL(url);
        expect(requestUrl.searchParams.get("method")).toBe("Events.getAction");
        return mockJsonResponse([
          { label: "view_item", nb_visits: 100 },
          { label: "add_to_cart", nb_visits: 40 },
          { label: "begin_checkout", nb_visits: 15 },
          { label: "purchase", nb_visits: 5 },
        ]) as any;
      });

      const steps = await getMatomoFunnel({ startDate: "2026-01-01", endDate: "2026-01-31" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(steps?.map((s) => s.step)).toEqual([
        "view_item",
        "add_to_cart",
        "begin_checkout",
        "purchase",
      ]);
      expect(steps?.map((s) => s.count)).toEqual([100, 40, 15, 5]);
    });

    it("returns null (not a zero-filled funnel) when Matomo is not configured", async () => {
      delete process.env.MATOMO_BASE_URL;
      const steps = await getMatomoFunnel({ startDate: "2026-01-01", endDate: "2026-01-31" });
      expect(steps).toBeNull();
    });

    it("returns null (not a zero-filled funnel) on a Matomo error", async () => {
      jest.spyOn(global, "fetch" as any).mockResolvedValue(
        mockJsonResponse({ result: "error", message: "Invalid token_auth" }) as any,
      );
      const steps = await getMatomoFunnel({ startDate: "2026-01-01", endDate: "2026-01-31" });
      expect(steps).toBeNull();
    });
  });
});
