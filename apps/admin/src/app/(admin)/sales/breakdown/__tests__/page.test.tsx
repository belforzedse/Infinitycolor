import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

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
  SuperAdminTable: ({ columns, data }: any) => {
    // Renders the first column through its `cell` renderer when it has one, so
    // the category tab's disclosure button is reachable from these tests. Mirrors
    // just enough of TanStack's cell context to drive it.
    const labelColumn = columns?.[0];
    return (
      <div data-testid="table">
        {(data ?? []).map((row: any) => (
          <div key={row.key} data-testid="table-row">
            {labelColumn?.cell
              ? labelColumn.cell({ row: { original: row }, getValue: () => row.label })
              : row.label}
            : {row.netToman}
          </div>
        ))}
      </div>
    );
  },
}));

jest.mock("@/components/SuperAdmin/reports/shared/SalesGeographyMap", () => ({
  __esModule: true,
  default: ({ rows }: { rows: Array<{ key: string }> }) => (
    <div data-testid="geography-map">{rows.length} rows</div>
  ),
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

  it("shows the Iran map above the table on the geography tab", async () => {
    mockTab = "geography";
    getSalesBreakdownMock.mockResolvedValue(
      makeResponse({
        dimension: "geography",
        rows: [
          {
            key: "تهران",
            label: "تهران",
            ordersCount: 5,
            units: 5,
            grossToman: 500,
            discountsToman: 0,
            refundsToman: 0,
            netToman: 500,
          },
          {
            key: "",
            label: "نامشخص",
            ordersCount: 2,
            units: 2,
            grossToman: 200,
            discountsToman: 0,
            refundsToman: 0,
            netToman: 200,
          },
        ],
      }),
    );
    render(<SalesBreakdownReportPage />);
    expect(await screen.findByTestId("geography-map")).toHaveTextContent("2 rows");
    expect(screen.getAllByTestId("table-row")).toHaveLength(2);
    expect(screen.queryByText(/بیشترین فروش بر اساس/)).not.toBeInTheDocument();
  });

  describe("category tab hierarchy", () => {
    const categoryRows = [
      { key: "1", label: "آرایشی", parentKey: null, depth: 0, ordersCount: 12, units: 3, grossToman: 900, discountsToman: 0, refundsToman: 0, netToman: 900 },
      { key: "2", label: "رژ لب", parentKey: "1", depth: 1, ordersCount: 7, units: 2, grossToman: 600, discountsToman: 0, refundsToman: 0, netToman: 600 },
      { key: "1:__self__", label: "آرایشی (مستقیم)", parentKey: "1", depth: 1, ordersCount: 4, units: 1, grossToman: 300, discountsToman: 0, refundsToman: 0, netToman: 300 },
      { key: "3", label: "مات", parentKey: "2", depth: 2, ordersCount: 2, units: 1, grossToman: 200, discountsToman: 0, refundsToman: 0, netToman: 200 },
    ];

    beforeEach(() => {
      mockTab = "category";
      getSalesBreakdownMock.mockResolvedValue(
        makeResponse({ dimension: "category", rows: categoryRows }),
      );
    });

    it("opens on the top-level categories only, with their rolled-up totals", async () => {
      render(<SalesBreakdownReportPage />);
      await screen.findByTestId("table");
      expect(screen.getAllByTestId("table-row")).toHaveLength(1);
      expect(screen.getByTestId("table-row")).toHaveTextContent("آرایشی: 900");
      expect(within(screen.getByTestId("table")).queryByText("رژ لب")).not.toBeInTheDocument();
    });

    it("reveals one level per disclosure click, not the whole subtree", async () => {
      render(<SalesBreakdownReportPage />);
      await screen.findByTestId("table");

      fireEvent.click(screen.getByRole("button", { name: /باز کردن زیرمجموعه‌های آرایشی/ }));
      await waitFor(() => expect(screen.getAllByTestId("table-row")).toHaveLength(3));
      const table = () => within(screen.getByTestId("table"));
      expect(table().getByText("رژ لب")).toBeInTheDocument();
      expect(table().getByText("آرایشی (مستقیم)")).toBeInTheDocument();
      // Grandchild stays hidden until its own parent is opened.
      expect(table().queryByText("مات")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /باز کردن زیرمجموعه‌های رژ لب/ }));
      await waitFor(() => expect(table().getByText("مات")).toBeInTheDocument());
    });

    it("collapses again on a second click", async () => {
      render(<SalesBreakdownReportPage />);
      await screen.findByTestId("table");
      const toggle = () => screen.getByRole("button", { name: /زیرمجموعه‌های آرایشی/ });
      fireEvent.click(toggle());
      await waitFor(() => expect(screen.getAllByTestId("table-row")).toHaveLength(3));
      fireEvent.click(toggle());
      await waitFor(() => expect(screen.getAllByTestId("table-row")).toHaveLength(1));
    });

    it("expand-all opens every level, and toggles back to collapsed", async () => {
      render(<SalesBreakdownReportPage />);
      await screen.findByTestId("table");
      fireEvent.click(screen.getByText("باز کردن همه"));
      await waitFor(() => expect(screen.getAllByTestId("table-row")).toHaveLength(4));
      fireEvent.click(screen.getByText("بستن همه"));
      await waitFor(() => expect(screen.getAllByTestId("table-row")).toHaveLength(1));
    });

    it("explains that a parent's number includes its children and that no column adds up", async () => {
      render(<SalesBreakdownReportPage />);
      expect(await screen.findByText(/شامل زیرمجموعه‌های آن هم هست/)).toBeInTheDocument();
      // A product belongs to every category it is filed under, so the overlap is not
      // limited to order counts — the note must not imply the money columns sum.
      expect(screen.getByText(/هیچ‌کدام از ستون‌ها جمع‌پذیر نیستند/)).toBeInTheDocument();
      expect(screen.getByText(/فقط\s*یک‌بار حساب شده است/)).toBeInTheDocument();
    });

    it("ranks the chart across all depths, not just the visible rows", async () => {
      render(<SalesBreakdownReportPage />);
      await screen.findByTestId("table");
      // Only the root is visible in the table, but every depth is ranked above it.
      expect(screen.getByText("بیشترین فروش بر اساس دسته‌بندی")).toBeInTheDocument();
      expect(screen.getByText("۹۰۰ تومان")).toBeInTheDocument();
      expect(screen.getByText("۶۰۰ تومان")).toBeInTheDocument();
      expect(screen.getByText("۲۰۰ تومان")).toBeInTheDocument();
    });

    it("stays flat, with no disclosure controls, when the backend sends no hierarchy", async () => {
      // The parent relation can't always be resolved (schema drift); the tab must
      // still render rather than losing its rows to a tree that isn't there.
      getSalesBreakdownMock.mockResolvedValue(
        makeResponse({
          dimension: "category",
          rows: [
            { key: "1", label: "آرایشی", parentKey: null, depth: 0, ordersCount: 1, units: 1, grossToman: 100, discountsToman: 0, refundsToman: 0, netToman: 100 },
            { key: "2", label: "رژ لب", parentKey: null, depth: 0, ordersCount: 1, units: 1, grossToman: 50, discountsToman: 0, refundsToman: 0, netToman: 50 },
          ],
        }),
      );
      render(<SalesBreakdownReportPage />);
      await screen.findByTestId("table");
      expect(screen.getAllByTestId("table-row")).toHaveLength(2);
      expect(screen.queryByText("باز کردن همه")).not.toBeInTheDocument();
    });
  });

  it("warns when the window had no settlement and the numbers fell back to delivered orders", async () => {
    getSalesBreakdownMock.mockResolvedValue(makeResponse({ ordersDefinition: "completed" }));
    render(<SalesBreakdownReportPage />);
    await screen.findByText(/بر پایه سفارش‌های «تحویل شده» محاسبه شده/);
  });

  it("stays silent about the definition when the window is settled", async () => {
    getSalesBreakdownMock.mockResolvedValue(makeResponse({ ordersDefinition: "settled" }));
    render(<SalesBreakdownReportPage />);
    await screen.findByTestId("table");
    expect(screen.queryByText(/بر پایه سفارش‌های «تحویل شده»/)).not.toBeInTheDocument();
  });

  it("surfaces a degradation warning so incomplete numbers are never shown as complete", async () => {
    getSalesBreakdownMock.mockResolvedValue(
      makeResponse({
        partial: true,
        warnings: [
          {
            code: "CATEGORY_HIERARCHY_UNAVAILABLE",
            message: "ساختار درختی دسته‌بندی‌ها قابل تشخیص نبود؛ فروش زیرمجموعه‌ها در دستهٔ والد جمع نشده است.",
          },
        ],
      }),
    );
    render(<SalesBreakdownReportPage />);
    await screen.findByText(/ساختار درختی دسته‌بندی‌ها قابل تشخیص نبود/);
  });

  it("shows no degradation banner on a full-fidelity response", async () => {
    getSalesBreakdownMock.mockResolvedValue(makeResponse({ warnings: [] }));
    render(<SalesBreakdownReportPage />);
    await screen.findByTestId("table");
    expect(screen.queryByText(/قابل تشخیص نبود/)).not.toBeInTheDocument();
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
