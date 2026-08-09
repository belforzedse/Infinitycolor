"use client";

import { usePathname } from "next/navigation";
import { AdminCard, SubNav } from "@/components/admin";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import {
  useReportQueryState,
  toDateOnly,
  parseDateOnly,
} from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import { getSalesNavForCapabilities } from "@/constants/salesNav";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * Sales workspace shell.
 *
 * Owns the two things every sales subpage used to re-declare for itself: the
 * section navigation and the reporting period. Because the range lives in nuqs
 * URL state (`start`/`end`), lifting the picker here means the period now
 * persists as you move between subpages instead of resetting to the last 30
 * days on each navigation.
 *
 * Subpages still call `useReportQueryState` to *read* the range — nuqs shares
 * one store per URL — they just no longer render their own picker.
 */

/**
 * Routes driven by the shared reporting period. Traffic brings its own
 * controls (including realtime auto-refresh) and Carts is not period-scoped,
 * so neither gets the shared picker.
 */
const DATE_SCOPED_ROUTES = [
  "/sales",
  "/sales/breakdown",
  "/sales/products",
  "/sales/funnel",
  "/sales/geography",
  "/sales/liquidity",
  "/sales/gateways",
];

export default function SalesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { adminRole, capabilities } = useCurrentUser();
  const items = getSalesNavForCapabilities(capabilities, adminRole);
  const { start, end, setRange } = useReportQueryState<never>({ tab: false });

  const showDateRange = DATE_SCOPED_ROUTES.includes(
    pathname.replace(/\/$/, ""),
  );

  return (
    <div className="w-full" dir="rtl">
      <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-4">
        <h1 className="min-w-0 break-words text-xl text-[#202224] md:text-2xl lg:text-3xl">
          گزارشات
        </h1>
      </div>

      <SubNav
        items={items.map(({ id, label, href }) => ({ id, label, href }))}
        className="mt-3"
        ariaLabel="بخش‌های فروش"
      />

      {showDateRange && (
        <AdminCard className="mt-4" padded={false}>
          <div className="p-4 md:p-5">
            <ReportDateRangeField
              start={parseDateOnly(start)}
              end={parseDateOnly(end)}
              onChange={(range) =>
                setRange({
                  start: toDateOnly(range.start),
                  end: toDateOnly(range.end),
                })
              }
            />
          </div>
        </AdminCard>
      )}

      <div className="mt-4 lg:mt-6">{children}</div>
    </div>
  );
}
