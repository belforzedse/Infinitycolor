import { apiClient } from "@/services";
import { getBehaviorView, validateBehaviorQuery } from "../behavior";

jest.mock("@/services", () => ({
  apiClient: { get: jest.fn() },
}));

const getMock = apiClient.get as jest.Mock;

const envelope = (
  status: "ok" | "empty" | "partial" | "unavailable",
  data: unknown,
) => ({
  data,
  meta: {
    source: "umami",
    timezone: "Asia/Tehran",
    currency: "IRR",
    definitionVersion: "umami-infinity-v1",
    dataStart: "2026-01-01",
    refreshedAt: "2026-02-01T00:00:00.000Z",
    cache: "miss",
    status,
    requestedRange: { start: "2026-02-01", end: "2026-02-02" },
  },
});

describe("behavior report client", () => {
  beforeEach(() => getMock.mockReset());

  it("validates date order and finite filter keys before making a request", async () => {
    const response = await getBehaviorView("overview", {
      start: "2026-02-02",
      end: "2026-02-01",
      comparison: "previous_period",
      filters: { path: "/plp", unsupported: "secret" } as any,
    });
    expect(response.state).toBe("unavailable");
    expect(response.error).toMatch(/تاریخ پایان|پشتیبانی/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("reads the exact backend data and metadata envelope", async () => {
    getMock.mockResolvedValueOnce(
      envelope("ok", {
        kind: "overview",
        summary: { visits: 12 },
        sections: { path: [] },
        errors: {},
      }),
    );
    const response = await getBehaviorView("overview", {
      start: "2026-02-01",
      end: "2026-02-02",
      comparison: "previous_period",
      filters: { utmSource: "google" },
    });

    expect(getMock.mock.calls[0][0]).toContain("/reports/behavior/overview");
    expect(getMock.mock.calls[0][0]).toContain("startDate=2026-02-01");
    expect(getMock.mock.calls[0][0]).toContain("utmSource=google");
    expect(response.state).toBe("ok");
    expect(response.data).toMatchObject({ summary: { visits: 12 } });
    expect(response.metadata).toMatchObject({
      provider: "Umami",
      dataStart: "2026-01-01",
      refreshedAt: "2026-02-01T00:00:00.000Z",
      cache: "miss",
    });
  });

  it("falls back only to an intentional compatibility alias", async () => {
    getMock.mockRejectedValueOnce({ status: 404, message: "not found" });
    getMock.mockResolvedValueOnce(
      envelope("empty", {
        kind: "conversion",
        summary: {},
        sections: {},
        errors: {},
      }),
    );
    const response = await getBehaviorView("conversion", {
      start: "2026-01-01",
      end: "2026-01-02",
    });

    expect(getMock.mock.calls[0][0]).toContain("/reports/behavior/conversion");
    expect(getMock.mock.calls[1][0]).toContain("/reports/funnel");
    expect(response.state).toBe("empty");
  });

  it("does not use the overview alias for purpose-only reports", async () => {
    getMock.mockRejectedValueOnce({ status: 404, message: "not found" });
    const response = await getBehaviorView("performance", {
      start: "2026-01-01",
      end: "2026-01-02",
    });
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(response.state).toBe("unavailable");
  });

  it("keeps unavailable data null and surfaces partial section warnings", async () => {
    getMock.mockResolvedValueOnce(envelope("unavailable", null));
    const unavailable = await getBehaviorView("realtime", {
      start: "2026-01-01",
      end: "2026-01-02",
    });
    expect(unavailable.state).toBe("unavailable");
    expect(unavailable.data).toBeNull();

    getMock.mockResolvedValueOnce(
      envelope("partial", {
        kind: "audience",
        sections: { device: [] },
        errors: { retention: "UMAMI_TIMEOUT" },
      }),
    );
    const partial = await getBehaviorView("audience", {
      start: "2026-01-01",
      end: "2026-01-02",
    });
    expect(partial.state).toBe("partial");
    expect(partial.metadata.warnings).toContain("بخش retention در دسترس نیست");
  });

  it("validates advanced UUID, event, and stable commerce identifiers", () => {
    expect(
      validateBehaviorQuery({
        start: "2026-01-01",
        end: "2026-01-02",
        filters: {
          event: "view_item",
          productId: "123",
          segment: "123e4567-e89b-42d3-a456-426614174000",
        },
      }).ok,
    ).toBe(true);
    expect(
      validateBehaviorQuery({
        start: "2026-01-01",
        end: "2026-01-02",
        filters: {
          event: "Invalid Event",
          productId: "customer@email.test",
          segment: "not-a-uuid",
        },
      }).ok,
    ).toBe(false);
  });
});
