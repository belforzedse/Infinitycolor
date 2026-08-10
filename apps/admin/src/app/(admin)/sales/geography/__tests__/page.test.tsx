import { render, screen, waitFor } from "@testing-library/react";

jest.mock("zaman", () => ({
  DatePicker: ({ onChange }: { onChange: (date: Date) => void }) => (
    <input
      data-testid="datepicker"
      onChange={(e) => onChange(new Date(e.target.value))}
    />
  ),
}));

jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

jest.mock("@/components/SuperAdmin/Table", () => ({
  SuperAdminTable: ({ data }: { data?: Array<{ key: string; label: string; netToman: number }> }) => (
    <div data-testid="table">
      {(data ?? []).map((row) => (
        <div key={row.key || row.label} data-testid="table-row">
          {row.label}: {row.netToman}
        </div>
      ))}
    </div>
  ),
}));

jest.mock("@/components/SuperAdmin/reports/shared/SalesGeographyMap", () => ({
  __esModule: true,
  default: ({ rows }: { rows: Array<{ key: string; label: string }> }) => (
    <div data-testid="geography-map">{rows.length} rows</div>
  ),
}));

let mockStart = "2026-01-01";
let mockEnd = "2026-01-31";
const setRangeMock = jest.fn((range: { start: string; end: string }) => {
  mockStart = range.start;
  mockEnd = range.end;
});

jest.mock("@/components/SuperAdmin/reports/shared/useReportQueryState", () => ({
  useReportQueryState: () => ({ start: mockStart, end: mockEnd, setRange: setRangeMock }),
}));

const getSalesBreakdownMock = jest.fn();
const downloadSalesBreakdownExcelMock = jest.fn().mockResolvedValue(undefined);

jest.mock("@/services/super-admin/reports/salesBreakdown", () => ({
  getSalesBreakdown: (...args: unknown[]) => getSalesBreakdownMock(...args),
  downloadSalesBreakdownExcel: (...args: unknown[]) =>
    downloadSalesBreakdownExcelMock(...args),
}));

import GeographyReportPage from "../page";

function makeResponse(
  rows: Array<{
    key: string;
    label: string;
    ordersCount: number;
    units: number;
    grossToman: number;
    discountsToman: number;
    refundsToman: number;
    netToman: number;
  }>,
  truncated = false,
) {
  return {
    dimension: "geography",
    range: { start: "2026-01-01", end: "2026-01-31" },
    currency: "Toman",
    timezone: "Asia/Tehran",
    definitionVersion: "sales.net@1",
    source: "commerce",
    refreshedAt: "2026-01-31T00:00:00.000Z",
    partial: false,
    truncated,
    rows,
  };
}

describe("GeographyReportPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStart = "2026-01-01";
    mockEnd = "2026-01-31";
  });

  it("fetches the geography dimension on mount", async () => {
    getSalesBreakdownMock.mockResolvedValue(makeResponse([]));
    render(<GeographyReportPage />);
    await waitFor(() =>
      expect(getSalesBreakdownMock).toHaveBeenCalledWith({
        dimension: "geography",
        start: "2026-01-01",
        end: "2026-01-31",
      }),
    );
  });

  it("renders the map and keeps all rows in the table", async () => {
    getSalesBreakdownMock.mockResolvedValue(
      makeResponse([
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
      ]),
    );
    render(<GeographyReportPage />);

    expect(await screen.findByTestId("geography-map")).toHaveTextContent("2 rows");
    expect(screen.getAllByTestId("table-row")).toHaveLength(2);
  });

  it("shows the truncation warning when the response is truncated", async () => {
    getSalesBreakdownMock.mockResolvedValue(
      makeResponse(
        [
          {
            key: "تهران",
            label: "تهران",
            ordersCount: 1,
            units: 1,
            grossToman: 1,
            discountsToman: 0,
            refundsToman: 0,
            netToman: 1,
          },
        ],
        true,
      ),
    );
    render(<GeographyReportPage />);
    await screen.findByText(/کمترین موارد در ردیف «سایر» جمع شده‌اند/);
  });

  it("shows an error message when the fetch fails", async () => {
    getSalesBreakdownMock.mockRejectedValue(new Error("boom"));
    render(<GeographyReportPage />);
    await waitFor(() => expect(screen.getByText(/خطا/)).toBeInTheDocument());
  });
});
