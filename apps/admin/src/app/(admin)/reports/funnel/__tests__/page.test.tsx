import { render, screen, waitFor } from "@testing-library/react";

jest.mock("zaman", () => ({
  DatePicker: ({ onChange }: any) => (
    <input data-testid="datepicker" onChange={(e) => onChange(new Date(e.target.value))} />
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
  useReportQueryState: () => ({ start: "2026-01-01", end: "2026-01-31", setRange: jest.fn() }),
}));

const getFunnelMock = jest.fn();
jest.mock("@/services/super-admin/reports/funnel", () => ({
  getFunnel: (...args: any[]) => getFunnelMock(...args),
}));

import FunnelReportPage from "../page";

function makeResponse(overrides: Partial<any> = {}) {
  return {
    range: { start: "2026-01-01", end: "2026-01-31" },
    timezone: "Asia/Tehran",
    configured: true,
    steps: [
      { step: "view_item", count: 100, conversionFromPrevious: null },
      { step: "add_to_cart", count: 40, conversionFromPrevious: 40 },
      { step: "begin_checkout", count: 15, conversionFromPrevious: 37.5 },
      { step: "purchase", count: 5, conversionFromPrevious: 33.33 },
    ],
    note: "این یک قیف مرحله‌ای است.",
    ...overrides,
  };
}

describe("FunnelReportPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetches the funnel on mount and renders every step in order", async () => {
    getFunnelMock.mockResolvedValue(makeResponse());
    render(<FunnelReportPage />);

    await waitFor(() =>
      expect(getFunnelMock).toHaveBeenCalledWith({ start: "2026-01-01", end: "2026-01-31" }),
    );
    await screen.findByText("مشاهده محصول");
    expect(screen.getByText("افزودن به سبد خرید")).toBeInTheDocument();
    expect(screen.getByText("شروع تسویه‌حساب")).toBeInTheDocument();
    expect(screen.getByText("خرید")).toBeInTheDocument();
  });

  it("shows an explicit 'not configured' message instead of a zeroed funnel", async () => {
    getFunnelMock.mockResolvedValue(makeResponse({ configured: false, steps: [] }));
    render(<FunnelReportPage />);
    await screen.findByText(/ماتومو پیکربندی نشده یا در دسترس نیست/);
    expect(screen.queryByText("مشاهده محصول")).not.toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    getFunnelMock.mockRejectedValue(new Error("boom"));
    render(<FunnelReportPage />);
    await waitFor(() => expect(screen.getByText(/خطا/)).toBeInTheDocument());
  });
});
