import { fireEvent, render, screen } from "@testing-library/react";

// zaman ships ESM-only and cannot be transformed by jest; the shared
// ReportDateRangeField spec stubs it the same way.
jest.mock("zaman", () => ({
  DatePicker: ({ defaultValue, onChange }: any) => (
    <input
      role="textbox"
      defaultValue={defaultValue?.toISOString?.().slice(0, 10) ?? ""}
      onChange={(e) => onChange(new Date(e.target.value))}
    />
  ),
}));

let mockPathname = "/sales";
let mockAdminRole: string | null = null;
let mockCapabilities: string[] = [];
const setRangeMock = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    adminRole: mockAdminRole,
    capabilities: mockCapabilities,
  }),
}));

jest.mock("@/components/SuperAdmin/reports/shared/useReportQueryState", () => ({
  useReportQueryState: () => ({
    start: "2026-01-01",
    end: "2026-01-31",
    setRange: setRangeMock,
  }),
  toDateOnly: (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`,
  parseDateOnly: (value: string) => new Date(`${value}T00:00:00`),
}));

import SalesLayout from "../layout";

describe("Sales workspace layout", () => {
  beforeEach(() => {
    setRangeMock.mockReset();
    mockPathname = "/sales";
    mockAdminRole = null;
    mockCapabilities = [];
  });

  describe("role-filtered sub-navigation", () => {
    // This surface is new and has no sidebar filter behind it. If it is not
    // filtered, Founder and Store manager see tabs whose endpoints return 403.
    it("shows every section to a Superadmin", () => {
      mockAdminRole = "superadmin";
      render(<SalesLayout>{null}</SalesLayout>);

      expect(
        screen.getByRole("link", { name: "نمای کلی" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "رفتار کاربران" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "نقدینگی" })).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "فعالیت مدیران" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "سبدهای خرید" }),
      ).not.toBeInTheDocument();
    });

    it("shows inherited finance, traffic, and cart reports to a Founder", () => {
      mockAdminRole = "founder";
      mockCapabilities = [
        "report.sales.read",
        "report.product.read",
        "report.finance.read",
        "report.traffic.read",
        "report.carts.read",
      ];
      render(<SalesLayout>{null}</SalesLayout>);

      // Founders keep the sales reports they were already allowed to view.
      expect(
        screen.getByRole("link", { name: "نمای کلی" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "فروش محصولات" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "تفکیک فروش" }),
      ).toBeInTheDocument();

      expect(
        screen.getByRole("link", { name: "رفتار کاربران" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "نقدینگی" })).toBeInTheDocument();
      // Activity is grouped here, but remains Superadmin-only.
      expect(
        screen.queryByRole("link", { name: "فعالیت مدیران" }),
      ).not.toBeInTheDocument();
    });

    it("shows product reporting only to a Store manager", () => {
      mockAdminRole = "store_manager";
      mockCapabilities = ["report.product.read"];
      render(<SalesLayout>{null}</SalesLayout>);

      expect(screen.getAllByRole("link")).toHaveLength(1);
      expect(
        screen.getByRole("link", { name: "فروش محصولات" }),
      ).toBeInTheDocument();
    });
  });

  describe("shared reporting period", () => {
    it("picking a preset reports the LOCAL calendar date, not a UTC-shifted one", () => {
      mockAdminRole = "superadmin";
      render(<SalesLayout>{null}</SalesLayout>);

      fireEvent.click(screen.getByText("این ماه"));

      expect(setRangeMock).toHaveBeenCalledTimes(1);
      const { start } = setRangeMock.mock.calls[0][0];
      const now = new Date();
      const expectedFirstOfMonth = `${now.getFullYear()}-${String(
        now.getMonth() + 1,
      ).padStart(2, "0")}-01`;
      expect(start).toBe(expectedFirstOfMonth);
    });

    it("is rendered once for every period-scoped subpage", () => {
      mockAdminRole = "superadmin";
      for (const pathname of [
        "/sales",
        "/sales/breakdown",
        "/sales/products",
        "/sales/liquidity",
      ]) {
        mockPathname = pathname;
        const { unmount } = render(<SalesLayout>{null}</SalesLayout>);
        expect(screen.getAllByText("این ماه")).toHaveLength(1);
        unmount();
      }
    });

    it("is omitted where the period does not apply", () => {
      mockAdminRole = "superadmin";
      // Behavior owns its own range, comparison and realtime controls.
      for (const pathname of ["/sales/traffic", "/sales/activity"]) {
        mockPathname = pathname;
        const { unmount } = render(<SalesLayout>{null}</SalesLayout>);
        expect(screen.queryByText("این ماه")).not.toBeInTheDocument();
        unmount();
      }
    });
  });
});
