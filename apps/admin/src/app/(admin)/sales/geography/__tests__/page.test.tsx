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

let lastChoroplethProps: any = null;
jest.mock("react-iran-maps", () => ({
  ChoroplethMap: (props: any) => {
    lastChoroplethProps = props;
    return <div data-testid="choropleth">{props.data?.length ?? 0} provinces</div>;
  },
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
  getSalesBreakdown: (...args: any[]) => getSalesBreakdownMock(...args),
  downloadSalesBreakdownExcel: (...args: any[]) => downloadSalesBreakdownExcelMock(...args),
}));

import GeographyReportPage from "../page";

function makeResponse(rows: any[], truncated = false) {
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
    lastChoroplethProps = null;
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

  it("excludes the unmapped ('') row from the map but keeps it in the table", async () => {
    getSalesBreakdownMock.mockResolvedValue(
      makeResponse([
        { key: "تهران", label: "تهران", ordersCount: 5, units: 5, grossToman: 500, discountsToman: 0, refundsToman: 0, netToman: 500 },
        { key: "", label: "نامشخص", ordersCount: 2, units: 2, grossToman: 200, discountsToman: 0, refundsToman: 0, netToman: 200 },
      ]),
    );
    render(<GeographyReportPage />);

    await screen.findByTestId("choropleth");
    expect(lastChoroplethProps.data).toEqual([{ name: "تهران", value: 500 }]);
    expect(screen.getAllByTestId("table-row")).toHaveLength(2);
    expect(screen.getByText(/سفارش بدون آدرس تحویل قابل‌شناسایی/)).toBeInTheDocument();
  });

  it("does not render the map when there are zero mappable rows (but still renders the table)", async () => {
    getSalesBreakdownMock.mockResolvedValue(makeResponse([]));
    render(<GeographyReportPage />);
    await screen.findByTestId("table");
    expect(screen.queryByTestId("choropleth")).not.toBeInTheDocument();
  });

  it("shows the truncation warning when the response is truncated", async () => {
    getSalesBreakdownMock.mockResolvedValue(
      makeResponse(
        [{ key: "تهران", label: "تهران", ordersCount: 1, units: 1, grossToman: 1, discountsToman: 0, refundsToman: 0, netToman: 1 }],
        true,
      ),
    );
    render(<GeographyReportPage />);
    await screen.findByText(/کمترین موارد در ردیف «سایر» جمع شده‌اند/);
  });

  it("escapes an interpolated province name in the tooltip HTML (XSS guard)", async () => {
    getSalesBreakdownMock.mockResolvedValue(
      makeResponse([
        {
          key: "x",
          label: '<img src=x onerror=alert(1)>',
          ordersCount: 1,
          units: 1,
          grossToman: 1000,
          discountsToman: 0,
          refundsToman: 0,
          netToman: 1000,
        },
      ]),
    );
    render(<GeographyReportPage />);
    await screen.findByTestId("choropleth");

    const html = lastChoroplethProps.renderTooltipContent({ name: '<img src=x onerror=alert(1)>', value: 1000 });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("shows an error message when the fetch fails", async () => {
    getSalesBreakdownMock.mockRejectedValue(new Error("boom"));
    render(<GeographyReportPage />);
    await waitFor(() => expect(screen.getByText(/خطا/)).toBeInTheDocument());
  });
});
