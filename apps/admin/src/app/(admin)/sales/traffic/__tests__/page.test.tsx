import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

jest.mock("zaman", () => ({
  DatePicker: ({ defaultValue, onChange }: any) => (
    <input
      aria-label="date"
      defaultValue={defaultValue?.toISOString?.().slice(0, 10)}
      onChange={(event) => onChange(new Date(event.target.value))}
    />
  ),
}));

jest.mock("@/components/SuperAdmin/reports/shared/useReportQueryState", () => ({
  useReportQueryState: () => ({
    start: "2026-01-01",
    end: "2026-01-31",
    values: { start: "2026-01-01", end: "2026-01-31", page: "1", view: "" },
    setRange: jest.fn(),
    setValues: jest.fn(),
  }),
  parseDateOnly: (value: string) => new Date(`${value}T00:00:00`),
  toDateOnly: (value: Date) => value.toISOString().slice(0, 10),
}));

const getBehaviorViewMock = jest.fn();
jest.mock("@/services/super-admin/reports/behavior", () => ({
  getBehaviorView: (...args: any[]) => getBehaviorViewMock(...args),
  validateBehaviorQuery: () => ({ ok: true, errors: {} }),
}));

import BehaviorReportPage from "../page";

const ok = (data: Record<string, unknown>) => ({
  state: "ok",
  data,
  metadata: {
    source: "umami",
    provider: "Umami",
    timezone: "Asia/Tehran",
    dataStart: "2026-01-01",
    refreshedAt: "2026-01-31T00:00:00.000Z",
    definitionVersion: "umami-infinity-v1",
    cache: "miss",
  },
});

const overview = ok({
  kind: "overview",
  summary: { pageviews: 9, visitors: 3, visits: 4, bounces: 1, totaltime: 120 },
  sections: {
    path: [
      {
        label: "/plp",
        pageviews: 9,
        visitors: 3,
        visits: 4,
        bounces: 1,
        totaltime: 120,
      },
    ],
    channel: [{ label: "llm", visits: 2 }],
    event: [{ label: "view_item", value: 3 }],
  },
  errors: {},
  comparison: {
    summary: {
      pageviews: 6,
      visitors: 2,
      visits: 3,
      bounces: 1,
      totaltime: 90,
    },
    sections: {},
    errors: {},
  },
});

describe("behavior report page", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    getBehaviorViewMock.mockReset().mockResolvedValue(overview);
  });

  afterEach(() => jest.useRealTimers());

  it("renders the seven exact views, shared Tehran range, and comparison", async () => {
    render(<BehaviorReportPage />);
    expect((await screen.findAllByText("نمایش صفحه")).length).toBeGreaterThan(0);
    expect(screen.getByText("ابزارهای هوش مصنوعی")).toBeInTheDocument();
    expect(screen.getByText("مشاهده محصول")).toBeInTheDocument();
    for (const label of [
      "خلاصه بازدیدها",
      "ورودی‌ها و تبلیغات",
      "مسیر خرید",
      "صفحات و محصولات",
      "شناخت کاربران",
      "سرعت و تجربه کاربری",
      "اکنون در سایت",
    ]) {
      expect(
        screen.getByRole("tab", { name: new RegExp(label) }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByText(/به وقت تهران/).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("date")).toHaveLength(2);
    expect(
      screen.getByRole("checkbox", { name: "مقایسه با دوره قبل" }),
    ).toBeChecked();
  });

  it("requests the selected purpose view with the shared query", async () => {
    render(<BehaviorReportPage />);
    await screen.findAllByText("نمایش صفحه");
    fireEvent.click(screen.getByRole("tab", { name: /شناخت کاربران/ }));
    await waitFor(() =>
      expect(getBehaviorViewMock).toHaveBeenCalledWith(
        "audience",
        expect.objectContaining({
          start: "2026-01-01",
          end: "2026-01-31",
          comparison: "previous_period",
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("renders commerce revenue in Toman and identifies it as authoritative", async () => {
    getBehaviorViewMock.mockImplementation(async (view: string) =>
      view === "conversion"
        ? ok({
            kind: "conversion",
            summary: { visits: 5 },
            sections: {
              commerce: {
                paidOrders: 2,
                totalOrders: 3,
                revenueToman: 1250000,
              },
              purchaseGoal: { num: 2, total: 5 },
              checkoutFunnel: [],
              event: [],
            },
            errors: {},
          })
        : overview,
    );
    render(<BehaviorReportPage />);
    await screen.findAllByText("نمایش صفحه");
    fireEvent.click(screen.getByRole("tab", { name: /مسیر خرید/ }));
    expect(await screen.findByText("فروش قطعی فروشگاه")).toBeInTheDocument();
    expect(screen.getByText(/۱٬۲۵۰٬۰۰۰ تومان/)).toBeInTheDocument();
    expect(screen.getByText(/مستقیماً از سفارش‌ها و پرداخت‌های فروشگاه/)).toBeInTheDocument();
  });

  it("renders a directly labelled purchase funnel with step drop-off", async () => {
    getBehaviorViewMock.mockImplementation(async (view: string) =>
      view === "conversion"
        ? ok({
            kind: "conversion",
            summary: { visits: 100 },
            sections: {
              commerce: { paidOrders: 30, totalOrders: 40, revenueToman: 5_000_000 },
              purchaseGoal: { num: 30, total: 100 },
              checkoutFunnel: [
                { value: "view_item", visitors: 100 },
                { value: "add_to_cart", visitors: 60 },
                { value: "begin_checkout", visitors: 45 },
                { value: "purchase", visitors: 30 },
              ],
              event: [],
            },
            errors: {},
          })
        : overview,
    );
    render(<BehaviorReportPage />);
    await screen.findAllByText("نمایش صفحه");
    fireEvent.click(screen.getByRole("tab", { name: /مسیر خرید/ }));
    expect(await screen.findByText("مسیر خرید کاربران")).toBeInTheDocument();
    expect(screen.getByText("افزودن به سبد خرید")).toBeInTheDocument();
    expect(screen.getAllByText(/ریزش این مرحله/)).toHaveLength(3);
    expect(screen.getByText(/تبدیل از ابتدا تا خرید/)).toHaveTextContent("۳۰٪");
    expect(
      screen.getByText(/بیشترین ریزش در مرحله «افزودن به سبد خرید» بوده است؛ ۴۰ کاربر/),
    ).toBeInTheDocument();
  });

  it("renders the journey flow with Persian labels and the 4-step cap footnote", async () => {
    getBehaviorViewMock.mockImplementation(async (view: string) =>
      view === "content"
        ? ok({
            kind: "content",
            summary: { visits: 50 },
            sections: {
              journeys: [
                {
                  e1: "view_item",
                  e2: "add_to_cart",
                  e3: "begin_checkout",
                  e4: "purchase",
                  count: 20,
                },
                { e1: "view_item", e2: "add_to_wishlist", count: 8 },
              ],
            },
            errors: {},
          })
        : overview,
    );
    render(<BehaviorReportPage />);
    await screen.findAllByText("نمایش صفحه");
    fireEvent.click(screen.getByRole("tab", { name: /صفحات و محصولات/ }));
    expect(
      await screen.findByText("پرتکرارترین توالی اقدام‌های کاربران"),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/مشاهده محصول/).length).toBeGreaterThan(0);
    expect(screen.getByText(/افزودن به علاقه‌مندی‌ها/)).toBeInTheDocument();
    expect(
      screen.getByText(/آنچه پس از اقدام چهارم رخ داده، در این داده دیده نمی‌شود/),
    ).toBeInTheDocument();
  });

  it("uses p75 Core Web Vitals values and readable device, browser, and path labels", async () => {
    getBehaviorViewMock.mockImplementation(async (view: string) =>
      view === "performance"
        ? ok({
            kind: "performance",
            summary: { visits: 5 },
            sections: {
              performance: {
                summary: {
                  lcp: { p50: 120, p75: 180, p95: 300 },
                  cls: { p50: 0.01, p75: 0.04, p95: 0.1 },
                },
                pages: [{ name: "/payment", p75: 180, count: 4 }],
                devices: [{ name: "laptop", p75: 150, count: 3 }],
                browsers: [{ name: "opera", p75: 170, count: 2 }],
                pageTitles: [],
              },
            },
            errors: {},
          })
        : overview,
    );
    const { container } = render(<BehaviorReportPage />);
    await screen.findAllByText("نمایش صفحه");
    fireEvent.click(screen.getByRole("tab", { name: /سرعت و تجربه کاربری/ }));
    expect(await screen.findByText("LCP صفحه‌ها")).toBeInTheDocument();
    expect(screen.getAllByText("۱۸۰ ms").length).toBeGreaterThan(0);
    expect(screen.getByText("پرداخت")).toBeInTheDocument();
    expect(screen.getByText("رایانه همراه")).toBeInTheDocument();
    expect(screen.getByText("Opera")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-dimension-icon]").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/ms —/)).not.toBeInTheDocument();
  });

  it("renders unavailable without inventing zero values", async () => {
    getBehaviorViewMock.mockResolvedValueOnce({
      state: "unavailable",
      data: null,
      error: "collector offline",
      metadata: { provider: "Umami", timezone: "Asia/Tehran", dataStart: null },
    });
    render(<BehaviorReportPage />);
    await screen.findByText("گزارش رفتار کاربران در دسترس نیست");
    expect(screen.queryByText(/^۰$/)).not.toBeInTheDocument();
  });

  it("polls realtime every 30 seconds and pauses while hidden", async () => {
    render(<BehaviorReportPage />);
    fireEvent.click(screen.getByRole("tab", { name: /اکنون در سایت/ }));
    await waitFor(() =>
      expect(getBehaviorViewMock).toHaveBeenCalledWith(
        "realtime",
        expect.anything(),
        expect.anything(),
      ),
    );
    getBehaviorViewMock.mockClear();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => jest.advanceTimersByTime(30_000));
    expect(getBehaviorViewMock).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(getBehaviorViewMock).toHaveBeenCalled());
  });
});
