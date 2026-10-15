import { act, fireEvent, render, screen } from "@testing-library/react";
import ReportExportsPage from "../page";
import { downloadReportExport, ReportExportError } from "@/services/super-admin/reports/exports";

const mockCapabilities = { current: [] as string[] };
const mockDownload = jest.mocked(downloadReportExport);

jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ capabilities: mockCapabilities.current }),
}));

jest.mock("@/services/super-admin/reports/exports", () => {
  const actual = jest.requireActual<typeof import("@/services/super-admin/reports/exports")>("@/services/super-admin/reports/exports");
  return {
    ...actual,
    downloadReportExport: jest.fn(),
  };
});

jest.mock("zaman", () => ({
  DatePicker: ({
    defaultValue,
    onChange,
    inputAttributes,
  }: {
    defaultValue?: Date;
    onChange?: (value: unknown) => void;
    inputAttributes?: { id?: string; "aria-label"?: string };
  }) => (
    <input
      id={inputAttributes?.id}
      aria-label={inputAttributes?.["aria-label"]}
      defaultValue={defaultValue ? `${defaultValue.getFullYear()}-${String(defaultValue.getMonth() + 1).padStart(2, "0")}-${String(defaultValue.getDate()).padStart(2, "0")}` : undefined}
      onChange={(event) => onChange?.(new Date(`${event.target.value}T00:00:00`))}
    />
  ),
}));

const allReportCapabilities = [
  "report.excel.export",
  "report.sales.read",
  "report.finance.read",
  "report.wallet.export",
  "report.inventory-history.export",
  "order.financial.read",
];

beforeEach(() => {
  mockCapabilities.current = [...allReportCapabilities];
  mockDownload.mockReset();
  mockDownload.mockResolvedValue({ rowCount: 4 });
});

describe("Excel report picker", () => {
  it("defaults to 30 inclusive Tehran days and respects the financial cutoff", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-14T12:00:00Z"));
    try {
      const first = render(<ReportExportsPage />);
      expect(screen.getByLabelText("تاریخ شروع")).toHaveValue("2026-09-15");
      expect(screen.getByLabelText("تاریخ پایان")).toHaveValue("2026-10-14");
      first.unmount();
      jest.setSystemTime(new Date("2026-09-20T12:00:00Z"));
      render(<ReportExportsPage />);
      expect(screen.getByLabelText("تاریخ شروع")).toHaveValue("2026-09-14");
    } finally { jest.useRealTimers(); }
  });
  it("shows only the active report's filters when switching reports", () => {
    render(<ReportExportsPage />);
    expect(screen.getByLabelText("تاریخ شروع")).toBeInTheDocument();
    expect(screen.getByLabelText("درگاه")).toBeInTheDocument();
    expect(screen.getByLabelText("نوع تراکنش")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "مالی" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "سایر" })).toHaveValue("Other");
    expect(screen.getByRole("option", { name: "نامشخص" })).toHaveValue("Unknown");

    fireEvent.change(screen.getByLabelText("گزارش"), { target: { value: "wallet" } });
    expect(screen.queryByLabelText("نوع تراکنش")).not.toBeInTheDocument();
    expect(screen.getByLabelText("نوع تغییر")).toBeInTheDocument();
    expect(screen.getByLabelText("منشأ تراکنش")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("گزارش"), { target: { value: "inventory-history" } });
    expect(screen.queryByLabelText("تاریخ شروع")).not.toBeInTheDocument();
    expect(screen.getByLabelText("کد محصول")).toBeInTheDocument();
    expect(screen.queryByLabelText("نوع تغییر")).not.toBeInTheDocument();
  });

  it("uses the shared order lifecycle labels in the order filters", () => {
    render(<ReportExportsPage />);
    fireEvent.change(screen.getByLabelText("گزارش"), { target: { value: "orders" } });

    expect(screen.getByRole("option", { name: "تکمیل شده" })).toHaveValue("Done");
    expect(screen.queryByRole("option", { name: "تحویل‌شده" })).not.toBeInTheDocument();
  });

  it("hides report choices when the matching capability is missing", () => {
    mockCapabilities.current = ["report.excel.export", "report.wallet.export"];
    render(<ReportExportsPage />);

    const report = screen.getByLabelText("گزارش") as HTMLSelectElement;
    expect([...report.options].map((option) => option.value)).toEqual(["wallet"]);
    expect(screen.getByLabelText("نوع تغییر")).toBeInTheDocument();
    expect(screen.queryByLabelText("کد محصولات")).not.toBeInTheDocument();
  });

  it("renders nothing for Finance or Founder without the Superadmin export capability", () => {
    for (const roleCapabilities of [
      ["report.sales.read", "report.finance.read", "order.financial.read"],
      ["report.sales.read", "report.finance.read", "order.financial.read", "report.wallet.export"],
    ]) {
      mockCapabilities.current = roleCapabilities;
      const { container, unmount } = render(<ReportExportsPage />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("requires financial order access before showing orders and buyer exports", () => {
    mockCapabilities.current = [
      "report.excel.export",
      "report.sales.read",
      "report.finance.read",
    ];
    render(<ReportExportsPage />);

    const report = screen.getByLabelText("گزارش") as HTMLSelectElement;
    expect([...report.options].map((option) => option.value)).not.toContain("orders");
    expect([...report.options].map((option) => option.value)).not.toContain("product-buyers");
    expect([...report.options].map((option) => option.value)).toContain("payments");
  });

  it("blocks a reversed date range before making a download request", () => {
    render(<ReportExportsPage />);
    fireEvent.change(screen.getByLabelText("تاریخ شروع"), { target: { value: "2026-10-14" } });
    fireEvent.change(screen.getByLabelText("تاریخ پایان"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "دانلود اکسل" }));

    expect(screen.getByRole("alert")).toHaveTextContent("تاریخ شروع باید پیش از تاریخ پایان باشد.");
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("disables repeated submits while downloading and reports an empty workbook", async () => {
    let resolveDownload: ((result: { rowCount: number }) => void) | undefined;
    mockDownload.mockImplementationOnce(() => new Promise((resolve) => { resolveDownload = resolve; }));
    render(<ReportExportsPage />);
    const button = screen.getByRole("button", { name: "دانلود اکسل" });

    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("در حال آماده‌سازی");
    expect(screen.getByLabelText("تاریخ شروع")).toBeDisabled();
    expect(screen.getByLabelText("تاریخ پایان")).toBeDisabled();
    fireEvent.click(button);
    expect(mockDownload).toHaveBeenCalledTimes(1);

    await act(async () => resolveDownload?.({ rowCount: 0 }));
    expect(screen.getByRole("status")).toHaveTextContent("فایل خالی دریافت شد.");
    expect(button).toBeEnabled();
    expect(screen.getByLabelText("تاریخ شروع")).toBeEnabled();
  });

  it("shows a concise recovery message for a large report", async () => {
    mockDownload.mockRejectedValueOnce(new ReportExportError("REPORT_TOO_LARGE"));
    render(<ReportExportsPage />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "دانلود اکسل" }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent("گزارش بزرگ‌تر از حد مجاز است");
    expect(screen.getByRole("alert")).toHaveTextContent("محدودتر کنید");
  });
});
