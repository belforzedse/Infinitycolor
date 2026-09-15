import { render, screen, waitFor } from "@testing-library/react";

jest.mock("zaman", () => ({
  DatePicker: ({ onChange }: any) => (
    <input
      data-testid="datepicker"
      onChange={(e) => onChange(new Date(e.target.value))}
    />
  ),
}));

jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: ({ title, children }: any) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

jest.mock("@/components/SuperAdmin/reports/shared/useReportQueryState", () => ({
  useReportQueryState: () => ({
    start: "2026-01-01",
    end: "2026-01-31",
    setRange: jest.fn(),
  }),
}));

const getOverviewMock = jest.fn();
jest.mock("@/services/super-admin/reports/overview", () => ({
  getOverview: (...args: any[]) => getOverviewMock(...args),
}));

import OverviewReportPage from "../page";

function makeDelta(current: number, previous: number) {
  const change = current - previous;
  return {
    current,
    previous,
    change,
    changePct:
      previous === 0 ? null : Number(((change / previous) * 100).toFixed(2)),
  };
}

function makeResponse(overrides: Partial<any> = {}) {
  return {
    range: { start: "2026-01-01", end: "2026-01-31" },
    previous: { start: "2025-12-01", end: "2025-12-31" },
    timezone: "Asia/Tehran",
    currency: "Toman",
    definitionVersion: "sales.grossWithShipping@1",
    sales: {
      // Gross carries the delivery fee; net does not (decision D16):
      // 1,120,000 − 120,000 − 50,000 − 50,000 = 900,000.
      gross: makeDelta(1_120_000, 800_000),
      net: makeDelta(900_000, 700_000),
      units: makeDelta(10, 8),
      orders: makeDelta(5, 4),
      discounts: makeDelta(50_000, 40_000),
      refunds: makeDelta(50_000, 60_000),
      shipping: makeDelta(120_000, 100_000),
    },
    analyticsDelivery: {
      status: "healthy",
      total: 2,
      pending: 0,
      processing: 0,
      deadLetter: 0,
      oldestPendingAt: null,
      lastSentAt: "2026-01-31T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("OverviewReportPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetches the overview on mount and renders the sales KPIs", async () => {
    getOverviewMock.mockResolvedValue(makeResponse());
    render(<OverviewReportPage />);

    await waitFor(() =>
      expect(getOverviewMock).toHaveBeenCalledWith({
        start: "2026-01-01",
        end: "2026-01-31",
      }),
    );
    // «فروش ناخالص» now appears twice: the KPI heading and the reconciliation
    // formula's term label. Pin this one to the heading.
    await screen.findByRole("heading", { name: "فروش ناخالص", level: 3 });
  });

  it("hands the delivery fee back before reaching the merchandise-only فروش خالص", async () => {
    getOverviewMock.mockResolvedValue(makeResponse());
    render(<OverviewReportPage />);

    // gross 1,120,000 − shipping 120,000 − discounts 50,000 − refunds 50,000 = net 900,000.
    const formula = (await screen.findAllByText("فروش ناخالص"))
      .map((el) => el.closest("div.rounded-xl"))
      .find(Boolean) as HTMLElement;
    expect(formula).toBeTruthy();
    expect(formula).toHaveTextContent("۱٬۱۲۰٬۰۰۰ تومان");
    expect(formula).toHaveTextContent("۱۲۰٬۰۰۰ تومان");
    expect(formula).toHaveTextContent("۹۰۰٬۰۰۰ تومان");
    // Shipping is a subtracted term, not a hidden caveat: the reader must see it leave.
    expect(formula).toHaveTextContent(/هزینه ارسال/);
    expect(formula).toHaveTextContent(/«فروش خالص» فقط فروش کالاست/);
    // The cross-page relationship is approximate; it must never read as equality.
    expect(formula).toHaveTextContent(/تقریباً/);
  });

  it("shows the shipping total as its own KPI so the gross can be taken apart", async () => {
    getOverviewMock.mockResolvedValue(makeResponse());
    render(<OverviewReportPage />);

    await screen.findByRole("heading", { name: "هزینه ارسال", level: 3 });
  });

  it("falls back to the three-term identity against an API older than the shipping field", async () => {
    // Admin and API ship as separate images: an older API sends no `shipping`
    // AND its gross is still line-only, so the page must drop the term rather
    // than read `undefined.current` and white-screen.
    const response = makeResponse();
    delete response.sales.shipping;
    response.sales.gross = makeDelta(1_000_000, 800_000);
    getOverviewMock.mockResolvedValue(response);
    render(<OverviewReportPage />);

    const formula = (await screen.findAllByText("فروش ناخالص"))
      .map((el) => el.closest("div.rounded-xl"))
      .find(Boolean) as HTMLElement;
    // 1,000,000 − 50,000 − 50,000 = 900,000, the pre-D16 arithmetic.
    expect(formula).toHaveTextContent("۱٬۰۰۰٬۰۰۰ تومان");
    expect(formula).toHaveTextContent("۹۰۰٬۰۰۰ تومان");
    expect(formula).toHaveTextContent(/هیچ‌کدام از این ارقام هزینه ارسال را در بر نمی‌گیرند/);
    expect(
      screen.queryByRole("heading", { name: "هزینه ارسال", level: 3 }),
    ).not.toBeInTheDocument();
  });

  it("shows the durable commerce delivery health", async () => {
    getOverviewMock.mockResolvedValue(makeResponse());
    render(<OverviewReportPage />);
    await screen.findByText("همه خریدها و مرجوعی‌ها در آمار ثبت شده‌اند");
  });

  it("shows dead-letter delivery as requiring attention", async () => {
    getOverviewMock.mockResolvedValue(
      makeResponse({
        analyticsDelivery: {
          status: "attention",
          total: 3,
          pending: 0,
          processing: 0,
          deadLetter: 1,
          oldestPendingAt: null,
          lastSentAt: null,
        },
      }),
    );
    render(<OverviewReportPage />);
    await screen.findByText("ثبت بعضی خریدها یا مرجوعی‌ها نیازمند بررسی است");
  });

  it("does not fabricate delivery health when the queue table is unavailable", async () => {
    getOverviewMock.mockResolvedValue(
      makeResponse({ analyticsDelivery: null }),
    );
    render(<OverviewReportPage />);
    await screen.findByText("وضعیت ثبت آمار خرید و مرجوعی در دسترس نیست.");
  });

  it("shows an error message when the fetch fails", async () => {
    getOverviewMock.mockRejectedValue(new Error("boom"));
    render(<OverviewReportPage />);
    await waitFor(() => expect(screen.getByText(/خطا/)).toBeInTheDocument());
  });

  it("does not leave permanent KPI skeletons behind when the fetch fails", async () => {
    getOverviewMock.mockRejectedValue(new Error("boom"));
    const { container } = render(<OverviewReportPage />);
    await waitFor(() => expect(screen.getByText(/خطا/)).toBeInTheDocument());
    expect(screen.queryByText("فروش")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });
});
