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
    definitionVersion: "sales.net@1",
    sales: {
      gross: makeDelta(1_000_000, 800_000),
      net: makeDelta(900_000, 700_000),
      units: makeDelta(10, 8),
      orders: makeDelta(5, 4),
      discounts: makeDelta(50_000, 40_000),
      refunds: makeDelta(50_000, 60_000),
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
    await screen.findByText("فروش ناخالص");
  });

  it("shows the durable commerce delivery health", async () => {
    getOverviewMock.mockResolvedValue(makeResponse());
    render(<OverviewReportPage />);
    await screen.findByText("صف تحویل سالم است");
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
    await screen.findByText(/نیازمند رسیدگی/);
  });

  it("does not fabricate delivery health when the queue table is unavailable", async () => {
    getOverviewMock.mockResolvedValue(
      makeResponse({ analyticsDelivery: null }),
    );
    render(<OverviewReportPage />);
    await screen.findByText("وضعیت صف تحویل در دسترس نیست.");
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
