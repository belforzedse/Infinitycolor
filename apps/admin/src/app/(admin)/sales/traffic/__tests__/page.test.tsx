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
    expect(await screen.findByText("بازدید صفحات")).toBeInTheDocument();
    expect(screen.getByText("ارجاع ابزارهای هوش مصنوعی")).toBeInTheDocument();
    expect(screen.getByText("مشاهده محصول")).toBeInTheDocument();
    for (const label of [
      "نمای کلی",
      "جذب و بازاریابی",
      "تبدیل",
      "محصول و محتوا",
      "مخاطبان",
      "عملکرد",
      "لحظه‌ای",
    ]) {
      expect(
        screen.getByRole("tab", { name: new RegExp(label) }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByText(/Asia\/Tehran/).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("date")).toHaveLength(2);
    expect(
      screen.getByRole("checkbox", { name: "مقایسه با دوره قبل" }),
    ).toBeChecked();
  });

  it("requests the selected purpose view with the shared query", async () => {
    render(<BehaviorReportPage />);
    await screen.findByText("بازدید صفحات");
    fireEvent.click(screen.getByRole("tab", { name: /مخاطبان/ }));
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
    await screen.findByText("بازدید صفحات");
    fireEvent.click(screen.getByRole("tab", { name: /تبدیل/ }));
    expect(await screen.findByText("فروش قطعی Infinity")).toBeInTheDocument();
    expect(screen.getByText(/۱٬۲۵۰٬۰۰۰ تومان/)).toBeInTheDocument();
    expect(screen.getByText(/Umami مرجع مالی نیست/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("tab", { name: /لحظه‌ای/ }));
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
