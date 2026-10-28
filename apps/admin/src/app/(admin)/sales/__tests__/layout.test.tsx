import { fireEvent, render, screen } from "@testing-library/react";

// zaman ships ESM-only and cannot be transformed by jest; the shared
// ReportDateRangeField spec stubs it the same way.
jest.mock("zaman", () => ({
  DatePicker: ({
    defaultValue,
    onChange,
    inputAttributes,
  }: {
    defaultValue?: Date;
    onChange?: (value: unknown) => void;
    inputAttributes?: { "aria-label"?: string; id?: string };
  }) => (
    <input
      role="textbox"
      id={inputAttributes?.id}
      aria-label={inputAttributes?.["aria-label"]}
      defaultValue={defaultValue?.toISOString?.().slice(0, 10) ?? ""}
      onChange={(e) => onChange?.(new Date(e.target.value))}
    />
  ),
}));

let mockPathname = "/sales";
let mockStart = "2026-01-01";
let mockEnd = "2026-12-31";
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

jest.mock("@/components/SuperAdmin/reports/shared/useReportQueryState", () => {
  const dates = jest.requireActual(
    "@/components/SuperAdmin/reports/shared/reportDates",
  );
  return {
    useReportQueryState: () => ({
      start: mockStart,
      end: mockEnd,
      setRange: setRangeMock,
    }),
    toDateOnly: dates.toDateOnly,
    parseDateOnly: dates.parseDateOnly,
    LEGACY_SALES_DATA_CUTOFF: dates.LEGACY_SALES_DATA_CUTOFF,
    LEGACY_SALES_DATA_NOTICE: dates.LEGACY_SALES_DATA_NOTICE,
    predatesLegacySalesCutoff: dates.predatesLegacySalesCutoff,
  };
});

import SalesLayout from "../layout";
import {
  LEGACY_SALES_DATA_CUTOFF,
  LEGACY_SALES_DATA_NOTICE,
  defaultReportEnd,
  defaultReportStart,
  thisJalaliMonthRange,
  toDateOnly,
} from "@/components/SuperAdmin/reports/shared/reportDates";

describe("Sales workspace layout", () => {
  beforeEach(() => {
    setRangeMock.mockReset();
    mockPathname = "/sales";
    mockStart = LEGACY_SALES_DATA_CUTOFF;
    mockEnd = "2026-12-31";
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
    it("picking این ماه reports the Jalali month start as a local YYYY-MM-DD", () => {
      mockAdminRole = "superadmin";
      render(<SalesLayout>{null}</SalesLayout>);

      fireEvent.click(screen.getByText("این ماه"));

      expect(setRangeMock).toHaveBeenCalledTimes(1);
      const { start } = setRangeMock.mock.calls[0][0] as { start: string };
      expect(start).toBe(toDateOnly(thisJalaliMonthRange().start));
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

    describe("quick presets at the storefront cutover", () => {
      beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
        jest.setSystemTime(new Date(2026, 8, 28, 12));
      });
      afterEach(() => jest.useRealTimers());

      it("starts a preset that reaches back before the cutoff at the cutoff", () => {
        mockAdminRole = "superadmin";
        render(<SalesLayout>{null}</SalesLayout>);

        fireEvent.click(screen.getByText("۳۰ روز گذشته"));

        expect(setRangeMock).toHaveBeenCalledWith({
          start: LEGACY_SALES_DATA_CUTOFF,
          end: "2026-09-28",
        });
      });

      it("leaves a preset that starts after the cutoff alone", () => {
        mockAdminRole = "superadmin";
        render(<SalesLayout>{null}</SalesLayout>);

        fireEvent.click(screen.getByText("۷ روز گذشته"));

        expect(setRangeMock).toHaveBeenCalledWith({ start: "2026-09-21", end: "2026-09-28" });
      });
    });

    it("says where the report starts when the period starts at the cutoff", () => {
      mockAdminRole = "superadmin";
      mockStart = LEGACY_SALES_DATA_CUTOFF;
      const { unmount } = render(<SalesLayout>{null}</SalesLayout>);
      expect(screen.getByText(/گزارش از ۲۳ شهریور شروع می‌شود/)).toBeInTheDocument();
      unmount();

      mockStart = "2026-10-01";
      render(<SalesLayout>{null}</SalesLayout>);
      expect(screen.queryByText(/گزارش از ۲۳ شهریور شروع می‌شود/)).not.toBeInTheDocument();
    });

    it("carries a chosen period onto the sub-nav links of the pages it scopes", () => {
      mockAdminRole = "superadmin";
      mockStart = "2026-09-20";
      render(<SalesLayout>{null}</SalesLayout>);

      const period = "?start=2026-09-20&end=2026-12-31";
      expect(screen.getByRole("link", { name: "تفکیک فروش" })).toHaveAttribute(
        "href",
        `/sales/breakdown${period}`,
      );
      expect(screen.getByRole("link", { name: "نقدینگی" })).toHaveAttribute(
        "href",
        `/sales/liquidity${period}`,
      );
      // Behavior brings its own range.
      expect(
        screen.getByRole("link", { name: "رفتار کاربران" }),
      ).toHaveAttribute("href", "/sales/traffic");
    });

    it("leaves the sub-nav links bare for the default period", () => {
      mockAdminRole = "superadmin";
      mockStart = defaultReportStart();
      mockEnd = defaultReportEnd();
      render(<SalesLayout>{null}</SalesLayout>);

      expect(screen.getByRole("link", { name: "تفکیک فروش" })).toHaveAttribute(
        "href",
        "/sales/breakdown",
      );
    });

    it("replaces the report with the legacy-site notice for a start on or before ۲۲ شهریور", () => {
      mockAdminRole = "superadmin";
      mockStart = "2026-09-13";
      render(
        <SalesLayout>
          <div>report body</div>
        </SalesLayout>,
      );

      expect(screen.getByText(LEGACY_SALES_DATA_NOTICE)).toBeInTheDocument();
      expect(screen.queryByText("report body")).not.toBeInTheDocument();
      // The picker stays so the operator can move the period forward.
      expect(screen.getByText("این ماه")).toBeInTheDocument();
    });

    it("offers a one-click jump to the cutoff that keeps the chosen end date", () => {
      mockAdminRole = "superadmin";
      mockStart = "2026-08-01";
      render(<SalesLayout>{null}</SalesLayout>);

      fireEvent.click(screen.getByText("نمایش از ۲۳ شهریور به بعد"));

      expect(setRangeMock).toHaveBeenCalledWith({
        start: LEGACY_SALES_DATA_CUTOFF,
        end: "2026-12-31",
      });
    });

    it("shows the report when the period starts on or after the cutoff", () => {
      mockAdminRole = "superadmin";
      for (const start of [LEGACY_SALES_DATA_CUTOFF, "2026-10-01"]) {
        mockStart = start;
        const { unmount } = render(
          <SalesLayout>
            <div>report body</div>
          </SalesLayout>,
        );
        expect(screen.getByText("report body")).toBeInTheDocument();
        expect(
          screen.queryByText(LEGACY_SALES_DATA_NOTICE),
        ).not.toBeInTheDocument();
        unmount();
      }
    });

    it("never shows the legacy notice on pages the period does not scope", () => {
      mockAdminRole = "superadmin";
      mockStart = "2026-01-01";
      for (const pathname of ["/sales/traffic", "/sales/activity"]) {
        mockPathname = pathname;
        const { unmount } = render(
          <SalesLayout>
            <div>report body</div>
          </SalesLayout>,
        );
        expect(screen.getByText("report body")).toBeInTheDocument();
        expect(
          screen.queryByText(LEGACY_SALES_DATA_NOTICE),
        ).not.toBeInTheDocument();
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
