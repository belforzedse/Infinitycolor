import { render, screen, fireEvent, waitFor } from "@testing-library/react";

jest.mock("zaman", () => ({
  DatePicker: ({ onChange }: any) => (
    <input data-testid="datepicker" onChange={(e) => onChange(new Date(e.target.value))} />
  ),
}));

// ContentWrapper transitively imports nuqs's Pagination component, which is ESM-only
// and not part of what this page test is exercising; stub it to a plain wrapper.
jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: ({ title, children }: any) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

jest.mock("@/components/SuperAdmin/Table", () => ({
  SuperAdminTable: ({ data }: any) => (
    <div data-testid="table">
      {(data ?? []).map((row: any) => (
        <div key={row.key} data-testid="table-row">
          {row.label}: {row.netToman}
        </div>
      ))}
    </div>
  ),
}));

jest.mock("@/components/SuperAdmin/reports/shared/charts", () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div>{children}</div>,
  Bar: ({ children }: any) => <div>{children}</div>,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  REPORT_CHART_COLORS: ["#000000"],
}));

let mockTab = "status";
const setTabMock = jest.fn((t: string) => {
  mockTab = t;
});
const setRangeMock = jest.fn();

jest.mock("@/components/SuperAdmin/reports/shared/useReportQueryState", () => ({
  toDateOnly: (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
  parseDateOnly: (value: string) => {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  },
  useReportQueryState: () => ({
    start: "2026-01-01",
    end: "2026-01-31",
    tab: mockTab,
    setTab: setTabMock,
    setRange: setRangeMock,
  }),
}));

const getSalesBreakdownMock = jest.fn();
const downloadSalesBreakdownExcelMock = jest.fn().mockResolvedValue(undefined);

jest.mock("@/services/super-admin/reports/salesBreakdown", () => ({
  getSalesBreakdown: (...args: any[]) => getSalesBreakdownMock(...args),
  downloadSalesBreakdownExcel: (...args: any[]) => downloadSalesBreakdownExcelMock(...args),
  SALES_BREAKDOWN_DIMENSIONS: ["status", "category", "customer", "coupon", "geography"],
}));

import SalesBreakdownReportPage from "../page";

function makeResponse(overrides: Partial<any> = {}) {
  return {
    dimension: "status",
    range: { start: "2026-01-01", end: "2026-01-31" },
    currency: "Toman",
    timezone: "Asia/Tehran",
    definitionVersion: "sales.net@1",
    source: "commerce",
    refreshedAt: "2026-01-31T00:00:00.000Z",
    partial: false,
    truncated: false,
    rows: [
      { key: "Done", label: "تکمیل‌شده", ordersCount: 3, units: 5, grossToman: 100, discountsToman: 0, refundsToman: 0, netToman: 100 },
    ],
    ...overrides,
  };
}

describe("SalesBreakdownReportPage", () => {
  beforeEach(() => {
    mockTab = "status";
    jest.clearAllMocks();
    getSalesBreakdownMock.mockResolvedValue(makeResponse());
  });

  it("fetches the current dimension/range on mount", async () => {
    render(<SalesBreakdownReportPage />);
    await screen.findByTestId("table");
    expect(getSalesBreakdownMock).toHaveBeenCalledWith({
      dimension: "status",
      start: "2026-01-01",
      end: "2026-01-31",
    });
  });

  it("renders fetched rows in the table", async () => {
    render(<SalesBreakdownReportPage />);
    await screen.findByText(/تکمیل‌شده: 100/);
  });

  it("switching dimension tabs calls setTab", async () => {
    render(<SalesBreakdownReportPage />);
    await screen.findByTestId("table");
    fireEvent.click(screen.getByText("کد تخفیف"));
    expect(setTabMock).toHaveBeenCalledWith("coupon");
  });

  it("shows a directly labelled coupon impact visualization", async () => {
    mockTab = "coupon";
    getSalesBreakdownMock.mockResolvedValue(
      makeResponse({
        dimension: "coupon",
        rows: [
          {
            key: "SUMMER10",
            label: "SUMMER10",
            ordersCount: 4,
            units: 6,
            grossToman: 1_000_000,
            discountsToman: 100_000,
            refundsToman: 0,
            netToman: 900_000,
          },
        ],
      }),
    );
    render(<SalesBreakdownReportPage />);
    expect(await screen.findByText("اثر کدهای تخفیف بر فروش")).toBeInTheDocument();
    expect(screen.getByText("SUMMER10")).toBeInTheDocument();
    expect(screen.getByText(/۴ سفارش · ۱۰۰٬۰۰۰ تومان تخفیف/)).toBeInTheDocument();
    expect(screen.getByText("۹۰۰٬۰۰۰ تومان")).toBeInTheDocument();
  });

  it("shows the truncation warning when the response is truncated", async () => {
    getSalesBreakdownMock.mockResolvedValue(makeResponse({ truncated: true }));
    render(<SalesBreakdownReportPage />);
    await screen.findByText(/کمترین موارد در ردیف «سایر» جمع شده‌اند/);
  });

  it("shows an error message when the fetch fails", async () => {
    getSalesBreakdownMock.mockRejectedValue(new Error("boom"));
    render(<SalesBreakdownReportPage />);
    await waitFor(() => expect(screen.getByText(/خطا/)).toBeInTheDocument());
  });

  it("links to /sales/products for the reused dimensions", () => {
    render(<SalesBreakdownReportPage />);
    const link = screen.getByText("گزارش فروش هر محصول");
    expect(link.closest("a")).toHaveAttribute("href", "/sales/products");
  });
});
