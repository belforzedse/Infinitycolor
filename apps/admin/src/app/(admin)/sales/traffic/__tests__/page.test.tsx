import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

jest.mock("zaman", () => ({
  DatePicker: ({ defaultValue, onChange }: { defaultValue?: Date; onChange: (date: Date) => void }) => (
    <input
      aria-label="date"
      defaultValue={defaultValue?.toISOString?.().slice(0, 10)}
      onChange={(event) => onChange(new Date(event.target.value))}
    />
  ),
}));

// URL state that behaves like nuqs: setValues re-renders with the merged values.
const mockInitialValues: { current: Record<string, string> } = { current: {} };
const mockSetValues = jest.fn();
jest.mock("@/components/SuperAdmin/reports/shared/useReportQueryState", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    useReportQueryState: () => {
      const [values, setState] = React.useState<Record<string, string>>(() => ({
        start: "2026-01-01",
        end: "2026-01-31",
        page: "1",
        ...mockInitialValues.current,
      }));
      const setValues = React.useCallback((updates: Record<string, string | null>) => {
        mockSetValues(updates);
        setState((current) => {
          const next = { ...current };
          for (const [key, value] of Object.entries(updates)) {
            if (value === null) delete next[key];
            else next[key] = value;
          }
          return next;
        });
        return Promise.resolve();
      }, []);
      return {
        start: values.start,
        end: values.end,
        values,
        setRange: jest.fn(),
        setValues,
      };
    },
    parseDateOnly: (value: string) => new Date(`${value}T00:00:00`),
    toDateOnly: (value: Date) => value.toISOString().slice(0, 10),
  };
});

const getBehaviorViewMock = jest.fn();
const getConversionDetailMock = jest.fn();
jest.mock("@/services/super-admin/reports/behavior", () => ({
  getBehaviorView: (...args: unknown[]) => getBehaviorViewMock(...args),
  getConversionDetail: (...args: unknown[]) => getConversionDetailMock(...args),
  validateBehaviorQuery: () => ({ ok: true, errors: {} }),
}));

import BehaviorReportPage from "../page";

const metadata = {
  source: "umami",
  provider: "Umami",
  providerContractVersion: "3.3.1",
  timezone: "Asia/Tehran",
  dataStart: "2026-01-01",
  refreshedAt: "2026-01-31T00:00:00.000Z",
  definitionVersion: "umami-infinity-v2",
  cache: "miss" as const,
};

const ok = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  state: "ok",
  data,
  metadata: { ...metadata, ...extra },
});

const CORE = ["view_item", "add_to_cart", "begin_checkout", "add_shipping_info", "place_order_attempt", "purchase"];
const steps = (counts: number[], events = CORE) =>
  counts.map((visitors, index) => ({ type: "event", value: events[index], visitors }));

const overview = ok({
  kind: "overview",
  summary: { pageviews: 9000, visitors: 3000, visits: 4000, bounces: 1000, totaltime: 120000 },
  sections: {
    trend: {
      unit: "day",
      points: [
        { t: "2026-01-30", pageviews: 300, visitors: 100 },
        { t: "2026-01-31", pageviews: 320, visitors: 110 },
      ],
    },
    analyticsDelivery: { status: "healthy", pending: 0, processing: 0, deadLetter: 0 },
  },
  errors: {},
  comparison: {
    summary: { pageviews: 6000, visitors: 2000, visits: 3000, bounces: 900, totaltime: 90000 },
    sections: {
      trend: {
        unit: "day",
        points: [
          { t: "2025-12-01", pageviews: 250, visitors: 90 },
          { t: "2025-12-02", pageviews: 260, visitors: 95 },
        ],
      },
    },
    errors: {},
  },
});

function conversionData(overrides: Record<string, unknown> = {}, comparison?: Record<string, unknown>) {
  return ok({
    kind: "conversion",
    summary: { visitors: 3000 },
    sections: {
      commerce: {
        source: "commerce",
        paidOrders: 24,
        totalOrders: 31,
        revenueToman: 1_250_000,
        range: { start: "2026-01-01", end: "2026-01-31" },
        series: { unit: "day", points: [{ t: "2026-01-31", paidOrders: 24, revenueToman: 1_250_000 }] },
      },
      purchaseTracking: { umamiPurchaseSessions: 20, commercePaidOrders: 24, coverage: 20 / 24, status: "live" },
      purchaseGoal: { num: 20, total: 3000 },
      funnelDefinitions: {
        core: { window: 1440, steps: CORE },
        checkout: { window: 60, steps: CORE.slice(2) },
        payment: { window: 60, steps: ["payment_redirect", "purchase"] },
      },
      stepFilters: { applied: [], ignored: [] },
      coreFunnel: steps([1000, 130, 46, 37, 31, 20]),
      discoveryFunnel: steps([1000, 130, 46]),
      checkoutFunnel: steps([60, 50, 40, 22], CORE.slice(2)),
      paymentFunnel: steps([35, 22], ["payment_redirect", "purchase"]),
      event: [
        { label: "payment_failed", count: 9, visitors: 7 },
        { label: "adaptive_quality_tier_change", count: 900, visitors: 90 },
      ],
      ...overrides,
    },
    errors: {},
    ...(comparison
      ? {
          comparison: {
            sections: comparison,
            errors: {},
          },
        }
      : {}),
  });
}

function respond(views: Record<string, unknown>) {
  getBehaviorViewMock.mockImplementation(async (view: string) =>
    view in views
      ? views[view]
      : view === "realtime"
        ? ok({ activeVisitors: 7, topPages: [{ path: "/plp", visitors: 4 }] })
        : ok({ kind: view, summary: { visits: 1 }, sections: {}, errors: {} }),
  );
}

describe("traffic and conversion workspace", () => {
  beforeAll(() => {
    // jsdom has no layout; the charts only need the observer to exist.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockInitialValues.current = {};
    mockSetValues.mockReset();
    getBehaviorViewMock.mockReset();
    getConversionDetailMock.mockReset();
    respond({ overview, conversion: conversionData() });
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("loads the pulse, trend and funnel from two parallel requests with one shared query", async () => {
    render(<BehaviorReportPage />);
    const expectedQuery = expect.objectContaining({
      start: "2026-01-01",
      end: "2026-01-31",
      comparison: "previous_period",
      filters: {},
    });
    await waitFor(() => {
      expect(getBehaviorViewMock).toHaveBeenCalledWith("overview", expectedQuery, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(getBehaviorViewMock).toHaveBeenCalledWith("conversion", expectedQuery, expect.anything());
    });
    const pulse = await screen.findByTestId("pulse-visitors");
    await waitFor(() => expect(within(pulse).getByText("۳٬۰۰۰")).toBeInTheDocument());
    // +50% against the previous period, with an arrow and words, not colour alone.
    expect(within(pulse).getByText("افزایش")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "قیف خرید و نرخ تبدیل" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "شاخص نمودار روند" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("date")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "مقایسه با دوره قبل" })).toBeChecked();
    expect(screen.getAllByText(/به وقت تهران/).length).toBeGreaterThan(0);
  });

  it("keeps orders and revenue on the storefront ledger and says so", async () => {
    render(<BehaviorReportPage />);
    const orders = await screen.findByTestId("pulse-orders");
    await waitFor(() => expect(within(orders).getByText("۲۴")).toBeInTheDocument());
    expect(screen.getByText("از سفارش‌های فروشگاه")).toBeInTheDocument();
    const revenue = screen.getByTestId("pulse-revenue");
    expect(within(revenue).getByText("۱٫۲۵ میلیون تومان")).toBeInTheDocument();
    expect(within(revenue).getByText("۱٬۲۵۰٬۰۰۰ تومان")).toBeInTheDocument();
    expect(screen.getByText(/سفارش‌های واردشده از سایت قدیم در این عددها نیستند/)).toBeInTheDocument();
    // The visitor conversion is Umami's own purchase goal, numerator and denominator stated.
    const conversion = screen.getByTestId("pulse-conversion");
    expect(within(conversion).getByText("۰٫۶۷٪")).toBeInTheDocument();
    expect(within(conversion).getByText("۲۰ خریدار از ۳٬۰۰۰ بازدیدکننده")).toBeInTheDocument();
  });

  it("compares orders only when the 23 Shahrivar floor clipped neither window", async () => {
    const conversion = conversionData();
    const withComparison = {
      ...conversion,
      metadata: { ...conversion.metadata, comparisonRange: { start: "2025-12-01", end: "2025-12-31" } },
      data: {
        ...conversion.data,
        comparison: {
          sections: {
            // The ledger was queried from the floor on, not from the requested start.
            commerce: { paidOrders: 8, totalOrders: 9, revenueToman: 400_000, range: { start: "2025-12-14", end: "2025-12-31" } },
          },
          errors: {},
        },
      },
    };
    respond({ overview, conversion: withComparison });
    render(<BehaviorReportPage />);
    const orders = await screen.findByTestId("pulse-orders");
    await waitFor(() => expect(within(orders).getByText("۲۴")).toBeInTheDocument());
    expect(within(orders).getByText(/بدون مقایسه: دوره قبل پیش از ۲۳ شهریور/)).toBeInTheDocument();
    expect(within(orders).queryByText("افزایش")).not.toBeInTheDocument();
    // Behavior is not floored, so its comparison stays.
    expect(within(screen.getByTestId("pulse-visitors")).getByText("افزایش")).toBeInTheDocument();
  });

  it("shows the end-to-end funnel with previous-step and overall rates and the largest loss", async () => {
    respond({
      overview,
      conversion: conversionData({}, { coreFunnel: steps([800, 80, 30, 25, 20, 16]), purchaseTracking: { status: "live" } }),
    });
    render(<BehaviorReportPage />);
    const funnel = await screen.findByRole("list", { name: "مراحل مسیر کامل خرید" });
    expect(within(funnel).getByText("مشاهده محصول")).toBeInTheDocument();
    expect(within(funnel).getByText("خرید موفق (تأییدشده)")).toBeInTheDocument();
    // 130 of 1,000 continued; 870 lost.
    expect(within(funnel).getByText("۱۳٪")).toBeInTheDocument();
    expect(within(funnel).getByText(/۸۷۰ نفر ریزش/)).toBeInTheDocument();
    expect(within(funnel).getByText("بیشترین ریزش")).toBeInTheDocument();
    // Three points better than the previous period's 10%.
    expect(within(funnel).getAllByText(/واحد درصد/).length).toBeGreaterThan(0);
    expect(screen.getByText("تبدیل کل قیف").nextSibling).toHaveTextContent("۲٪");
    expect(screen.getByText(/حداکثر ۲۴ ساعت پس از مرحله قبل/)).toBeInTheDocument();
  });

  it("withholds purchase numbers when purchase tracking is incomplete instead of showing zero", async () => {
    respond({
      overview,
      conversion: conversionData({
        coreFunnel: steps([1000, 130, 46, 37, 31, 1]),
        purchaseGoal: { num: 1, total: 181_755 },
        purchaseTracking: { umamiPurchaseSessions: 1, commercePaidOrders: 24, coverage: 1 / 24, status: "not_live" },
      }),
    });
    render(<BehaviorReportPage />);
    const funnel = await screen.findByRole("list", { name: "مراحل مسیر کامل خرید" });
    expect(within(funnel).getByText(/ردیابی خرید در این بازه کامل نیست/)).toBeInTheDocument();
    expect(within(funnel).getByText("ثبت ناقص")).toBeInTheDocument();
    expect(screen.getByText("رسیدند به «تلاش برای ثبت سفارش»")).toBeInTheDocument();
    expect(within(screen.getByTestId("pulse-conversion")).getByText("ردیابی خرید ناقص است")).toBeInTheDocument();
    expect(screen.getAllByTestId("purchase-reconciliation")[0]).toHaveAttribute("data-status", "not_live");
    expect(screen.queryByText("۰٫۰۱٪")).not.toBeInTheDocument();
  });

  it("names the filters the funnel could not apply", async () => {
    mockInitialValues.current = { utmSource: "instagram", device: "mobile" };
    respond({
      overview,
      conversion: conversionData({ stepFilters: { applied: ["device"], ignored: ["utmSource"] } }),
    });
    render(<BehaviorReportPage />);
    expect(
      await screen.findByText(/این فیلترها روی قیف و نرخ تبدیل اعمال نشدند.*منبع تبلیغ/),
    ).toBeInTheDocument();
    expect(getBehaviorViewMock).toHaveBeenCalledWith(
      "conversion",
      expect.objectContaining({ filters: { device: "mobile", utmSource: "instagram" } }),
      expect.anything(),
    );
    expect(screen.getByRole("list", { name: "فیلترهای فعال" })).toHaveTextContent("همه بخش‌ها");
    expect(within(screen.getByTestId("pulse-orders")).getByText(/روی سفارش‌ها اعمال نمی‌شوند/)).toBeInTheDocument();
  });

  it("applies an inline filter through the shareable URL state", async () => {
    render(<BehaviorReportPage />);
    await screen.findByTestId("pulse-visitors");
    fireEvent.change(screen.getByRole("combobox", { name: "دستگاه" }), { target: { value: "mobile" } });
    expect(mockSetValues).toHaveBeenCalledWith(expect.objectContaining({ device: "mobile", page: "1" }));
    await waitFor(() =>
      expect(getBehaviorViewMock).toHaveBeenCalledWith(
        "overview",
        expect.objectContaining({ filters: { device: "mobile" } }),
        expect.anything(),
      ),
    );
  });

  it("loads a funnel drill-down only when its perspective is opened", async () => {
    getConversionDetailMock.mockResolvedValue(
      ok({
        kind: "conversion-trend",
        sections: {
          buckets: [
            { startDate: "2026-01-01", endDate: "2026-01-07", days: 7, incomplete: false, steps: steps([200, 30, 10, 8, 7, 5]), purchaseGoal: { num: 5, total: 700 } },
            { startDate: "2026-01-29", endDate: "2026-01-31", days: 3, incomplete: true, steps: steps([90, 10, 4, 3, 3, 2]), purchaseGoal: { num: 2, total: 300 } },
          ],
        },
        errors: {},
      }),
    );
    render(<BehaviorReportPage />);
    await screen.findByRole("list", { name: "مراحل مسیر کامل خرید" });
    expect(getConversionDetailMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "روند" }));
    await waitFor(() =>
      expect(getConversionDetailMock).toHaveBeenCalledWith(
        expect.objectContaining({ start: "2026-01-01" }),
        { detail: "trend", funnel: "core" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(mockSetValues).toHaveBeenCalledWith({ fview: "trend" });
    const trendView = await screen.findByRole("region", { name: "نمای روند" });
    fireEvent.click(await within(trendView).findByRole("button", { name: "نمایش جدول" }));
    const table = await screen.findByRole("table", { name: "روند نرخ‌های قیف" });
    expect(within(table).getByText("(ناتمام)")).toBeInTheDocument();
    expect(within(table).getAllByText("۲٫۵٪").length).toBeGreaterThan(0);
  });

  it("ranks drop-offs, shows checkout evidence, and loads real journeys on demand", async () => {
    getConversionDetailMock.mockResolvedValue(
      ok({ kind: "conversion-journey", sections: { journeys: [{ e1: "add_to_cart", e2: "/cart", count: 12 }] }, errors: {} }),
    );
    mockInitialValues.current = { fview: "dropoff" };
    render(<BehaviorReportPage />);
    const table = await screen.findByRole("table", { name: /ریزش مرحله به مرحله/ });
    const firstRow = within(table).getAllByRole("row")[1];
    expect(firstRow).toHaveTextContent("مشاهده محصول ← افزودن به سبد خرید");
    expect(firstRow).toHaveTextContent("۸۷۰");
    const evidence = screen.getByRole("table", { name: "رخدادهای ثبت سفارش و پرداخت" });
    expect(within(evidence).getByText("پرداخت ناموفق")).toBeInTheDocument();
    expect(within(evidence).queryByText("تغییر خودکار کیفیت نمایش")).not.toBeInTheDocument();
    fireEvent.click(within(firstRow).getByRole("button", { name: "مسیرهای بعدی" }));
    await waitFor(() =>
      expect(getConversionDetailMock).toHaveBeenCalledWith(
        expect.anything(),
        { detail: "journey", step: "view_item" },
        expect.anything(),
      ),
    );
  });

  it("falls back to the separate funnels against an older report API", async () => {
    respond({ overview, conversion: conversionData({ coreFunnel: undefined }) });
    render(<BehaviorReportPage />);
    expect(await screen.findByText(/سرور گزارش هنوز قیف کامل را ارائه نمی‌دهد/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "کشف محصول" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "روند" })).toBeDisabled();
  });

  it("loads a deeper tab on demand and switches it through the URL", async () => {
    render(<BehaviorReportPage />);
    await screen.findByTestId("pulse-visitors");
    await waitFor(() =>
      expect(getBehaviorViewMock).toHaveBeenCalledWith("acquisition", expect.anything(), expect.anything()),
    );
    fireEvent.click(screen.getByRole("tab", { name: /مخاطبان/ }));
    expect(mockSetValues).toHaveBeenCalledWith({ view: "audience" });
    await waitFor(() =>
      expect(getBehaviorViewMock).toHaveBeenCalledWith(
        "audience",
        expect.objectContaining({ start: "2026-01-01", comparison: "previous_period" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("shows acquisition quality with attributed buyers and full values for long labels", async () => {
    const longCampaign = "autumn-sale_2026_instagram-story-carousel-variant-b-very-long-name";
    mockInitialValues.current = { view: "acquisition" };
    respond({
      overview,
      conversion: conversionData(),
      acquisition: ok({
        kind: "acquisition",
        summary: { visitors: 3000 },
        sections: {
          channel: [{ label: "direct", visitors: 1200, visits: 1500, bounces: 600, pageviews: 4000, totaltime: 90000 }],
          referrer: [{ label: `instagram.com`, visitors: 800, visits: 900 }],
          utmCampaign: [{ label: longCampaign, visitors: 300, visits: 320 }],
          firstAttribution: {
            referrer: [{ label: "instagram.com", value: 8 }],
            utm_campaign: [{ label: longCampaign, value: 3 }],
            total: { visitors: 20 },
          },
          lastAttribution: { referrer: [], total: { visitors: 20 } },
        },
        errors: {},
      }),
    });
    render(<BehaviorReportPage />);
    const sources = await screen.findByRole("table", { name: "سایت ارجاع‌دهنده" });
    expect(within(sources).getByText("۸")).toBeInTheDocument();
    expect(within(sources).getByText("۱٪")).toBeInTheDocument();
    expect(screen.getByText("مستقیم یا بدون منبع مشخص")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "نام کمپین" }));
    const campaigns = await screen.findByRole("table", { name: "نام کمپین" });
    expect(within(campaigns).getByTitle(longCampaign)).toBeInTheDocument();
  });

  it("uses rated p75 Core Web Vitals with readable device, browser and page labels", async () => {
    mockInitialValues.current = { view: "performance" };
    respond({
      overview,
      conversion: conversionData(),
      performance: ok({
        kind: "performance",
        summary: { visits: 5 },
        sections: {
          performance: {
            summary: { lcp: { p50: 120, p75: 180, p95: 300 }, cls: { p50: 0.01, p75: 0.3, p95: 0.4 } },
            pages: [{ name: "/payment", p75: 4200, count: 4 }],
            devices: [{ name: "laptop", p75: 150, count: 3 }],
            browsers: [{ name: "opera", p75: 170, count: 2 }],
            pageTitles: [],
          },
        },
        errors: {},
      }),
    });
    const { container } = render(<BehaviorReportPage />);
    const vitals = await screen.findByRole("table", { name: "Core Web Vitals" });
    expect(within(vitals).getByText("۱۸۰ میلی‌ثانیه")).toBeInTheDocument();
    expect(within(vitals).getByText("خوب")).toBeInTheDocument();
    expect(within(vitals).getByText("ضعیف")).toBeInTheDocument();
    const lcp = () => screen.getByRole("table", { name: "LCP به تفکیک" });
    expect(within(lcp()).getByText("پرداخت")).toBeInTheDocument();
    expect(within(lcp()).getByText("ضعیف")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "دستگاه" }));
    await waitFor(() => expect(within(lcp()).getByText("رایانه همراه")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "مرورگر" }));
    await waitFor(() => expect(within(lcp()).getByText("Opera")).toBeInTheDocument());
    expect(container.querySelectorAll("[data-dimension-icon]").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\bms\b/)).not.toBeInTheDocument();
  });

  it("renders the journeys of the content tab as real paths, not a funnel", async () => {
    mockInitialValues.current = { view: "content" };
    respond({
      overview,
      conversion: conversionData(),
      content: ok({
        kind: "content",
        summary: { visits: 50 },
        sections: {
          journeys: [
            { e1: "/pdp/red-shirt", e2: "add_to_cart", e3: "begin_checkout", e4: "purchase", count: 20 },
            { e1: "view_item", e2: "add_to_wishlist", count: 8 },
          ],
        },
        errors: {},
      }),
    });
    render(<BehaviorReportPage />);
    expect(await screen.findByText("مسیرهای واقعی بازدیدکنندگان")).toBeInTheDocument();
    expect(screen.getAllByText(/محصول: red shirt/).length).toBeGreaterThan(0);
    expect(screen.getByText(/افزودن به علاقه‌مندی‌ها/)).toBeInTheDocument();
  });

  it("renders an unavailable report without inventing zero values", async () => {
    const unavailable = {
      state: "unavailable",
      data: null,
      error: "collector offline",
      metadata: { provider: "Umami", timezone: "Asia/Tehran", dataStart: null },
    };
    respond({ overview: unavailable, conversion: unavailable, acquisition: unavailable });
    render(<BehaviorReportPage />);
    expect(await screen.findByText("گزارش رفتار کاربران در دسترس نیست")).toBeInTheDocument();
    expect(within(screen.getByTestId("pulse-visitors")).getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/^۰$/)).not.toBeInTheDocument();
    expect(screen.queryByText("۰٪")).not.toBeInTheDocument();
  });

  it("tells an empty period apart from a failure", async () => {
    const empty = { state: "empty", data: { sections: {}, errors: {} }, metadata };
    respond({ overview: empty, conversion: empty });
    render(<BehaviorReportPage />);
    expect(await screen.findByText("برای بازه و فیلتر انتخابی داده‌ای ثبت نشده است")).toBeInTheDocument();
    expect(screen.queryByText("گزارش رفتار کاربران در دسترس نیست")).not.toBeInTheDocument();
  });

  it("keeps the working sections and lists each distinct partial failure once", async () => {
    respond({
      overview: {
        ...overview,
        state: "partial",
        error: "UMAMI_INVALID_RESPONSE",
        metadata: {
          ...metadata,
          warnings: ["HTTP_500", "بخش checkoutFunnel در دسترس نیست", "بخش checkoutFunnel در دسترس نیست"],
        },
      },
      conversion: conversionData(),
    });
    render(<BehaviorReportPage />);
    const banner = (
      await screen.findByText("بخشی از گزارش در دسترس نیست؛ بخش‌های موجود نمایش داده شده‌اند")
    ).closest("[role=status]") as HTMLElement;
    expect(within(banner).getAllByText("مسیر ثبت سفارش تا خرید موقتاً در دسترس نیست.")).toHaveLength(1);
    expect(within(banner).queryByText("بخشی از اطلاعات این گزارش موقتاً در دسترس نیست.")).not.toBeInTheDocument();
    // The rest of the workspace still renders.
    expect(await screen.findByRole("list", { name: "مراحل مسیر کامل خرید" })).toBeInTheDocument();
  });

  it("polls realtime as a compact indicator and pauses while the tab is hidden", async () => {
    render(<BehaviorReportPage />);
    expect(await screen.findByRole("button", { name: /۷ نفر اکنون در سایت/ })).toBeInTheDocument();
    getBehaviorViewMock.mockClear();
    act(() => jest.advanceTimersByTime(60_000));
    await waitFor(() =>
      expect(getBehaviorViewMock).toHaveBeenCalledWith("realtime", expect.anything(), expect.objectContaining({ fresh: true })),
    );
    fireEvent.click(screen.getByRole("button", { name: /نفر اکنون در سایت/ }));
    expect(await screen.findByText(/فعال در ۳۰ دقیقه اخیر/)).toBeInTheDocument();
    getBehaviorViewMock.mockClear();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => jest.advanceTimersByTime(30_000));
    expect(getBehaviorViewMock).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(getBehaviorViewMock).toHaveBeenCalledWith("realtime", expect.anything(), expect.anything()));
  });

  it("states the Umami contract version and unsupported capabilities in data health", async () => {
    render(<BehaviorReportPage />);
    const health = await screen.findByTestId("behavior-metadata");
    await waitFor(() => expect(health).toHaveAttribute("data-start", "2026-01-01"));
    expect(within(health).getByText("Umami 3.3.1")).toBeInTheDocument();
    expect(within(health).getByText(/زمان تا تبدیل/)).toBeInTheDocument();
    expect(within(health).getByText(/کیفیت داده و اتصال: سالم/)).toBeInTheDocument();
  });
});
