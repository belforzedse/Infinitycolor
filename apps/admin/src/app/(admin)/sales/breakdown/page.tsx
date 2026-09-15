"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { BarChart3, ChevronLeft, TicketPercent } from "lucide-react";
import SalesPage from "../_components/SalesPage";
import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import ReportExportButton from "@/components/SuperAdmin/reports/shared/ReportExportButton";
import SalesGeographyMap from "@/components/SuperAdmin/reports/shared/SalesGeographyMap";
import {
  useReportQueryState,
} from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import {
  getSalesBreakdown,
  downloadSalesBreakdownExcel,
  SALES_BREAKDOWN_DIMENSIONS,
  type SalesBreakdownDimension,
  type SalesBreakdownResponse,
} from "@/services/super-admin/reports/salesBreakdown";
import {
  buildCategoryTree,
  expandableKeys,
  flattenVisible,
  hasHierarchy,
  type FlatCategoryRow,
} from "./categoryTree";
import { priceFormatter } from "@/utils/price";
import { faNum } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

const DIMENSION_LABELS: Record<SalesBreakdownDimension, string> = {
  status: "وضعیت سفارش",
  category: "دسته‌بندی",
  customer: "مشتری",
  coupon: "کد تخفیف",
  geography: "استان",
};

const CHART_TOP_N = 8;

function toman(value: number): string {
  return `${priceFormatter(value)} تومان`;
}

function RankedBreakdownChart({
  dimension,
  rows,
}: {
  dimension: SalesBreakdownDimension;
  rows: SalesBreakdownResponse["rows"];
}) {
  if (!rows.length) return null;
  const maximum = Math.max(...rows.map((row) => Math.abs(row.netToman)), 1);
  const isCoupon = dimension === "coupon";
  const Icon = isCoupon ? TicketPercent : BarChart3;
  return (
    <figure
      className="mb-6 overflow-hidden rounded-2xl border border-neutral-100 bg-neutral-50/60"
      aria-labelledby="sales-breakdown-chart-title"
    >
      <figcaption className="flex items-start gap-3 border-b border-neutral-100 bg-white px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-infinity-primary/10 text-infinity-primary">
          <Icon aria-hidden className="size-5" />
        </span>
        <div>
          <h2 id="sales-breakdown-chart-title" className="text-sm font-semibold text-neutral-800">
            {isCoupon ? "اثر کدهای تخفیف بر فروش" : `بیشترین فروش بر اساس ${DIMENSION_LABELS[dimension]}`}
          </h2>
          <p className="mt-1 text-xs leading-5 text-neutral-500">
            {isCoupon
              ? "فروش خالص، تعداد سفارش و مبلغ تخفیف هر کد را در یک نگاه مقایسه کنید."
              : "طول هر نوار فروش خالص را نشان می‌دهد؛ مبلغ و تعداد سفارش کنار همان مورد نوشته شده است."}
          </p>
        </div>
      </figcaption>
      <ol className="divide-y divide-neutral-100 p-2">
        {rows.map((row, index) => {
          const width = Math.max(0, Math.min(100, (Math.abs(row.netToman) / maximum) * 100));
          return (
            <li key={row.key || `${row.label}-${index}`} className="relative overflow-hidden rounded-xl px-3 py-3">
              <span
                aria-hidden
                className={`absolute inset-y-1 right-1 rounded-lg ${row.netToman < 0 ? "bg-rose-100" : "bg-infinity-primary/[0.075]"}`}
                style={{ width: `${width}%` }}
              />
              <div className="relative flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white text-xs font-semibold text-neutral-500 shadow-sm">
                    {faNum(index + 1)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-800" title={row.label}>
                      {row.label}
                    </p>
                    <p className="mt-1 text-[11px] text-neutral-500">
                      {faNum(row.ordersCount)} سفارش
                      {isCoupon ? ` · ${toman(row.discountsToman)} تخفیف` : ` · ${faNum(row.units)} کالا`}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 text-left sm:text-right">
                  <p className={`text-sm font-semibold tabular-nums ${row.netToman < 0 ? "text-rose-700" : "text-neutral-800"}`}>
                    {toman(row.netToman)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-neutral-400">
                    {row.netToman < 0 ? "فروش خالص منفی" : "فروش خالص"}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}

/** Indent step per tree level, in px. */
const TREE_INDENT = 18;

/**
 * The category label cell: indent, plus a disclosure button on any row that has
 * children. Padding is `inline-start`, not `left` — this page renders RTL, so a
 * left-hand indent would put the nesting on the wrong side.
 */
function CategoryLabelCell({
  row,
  onToggle,
}: {
  row: FlatCategoryRow;
  onToggle: (key: string) => void;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-2"
      style={{ paddingInlineStart: row.treeDepth * TREE_INDENT }}
    >
      {row.hasChildren ? (
        <button
          type="button"
          onClick={() => onToggle(row.key)}
          aria-expanded={row.isExpanded}
          aria-label={`${row.isExpanded ? "بستن" : "باز کردن"} زیرمجموعه‌های ${row.label}`}
          className="grid size-6 shrink-0 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700"
        >
          <ChevronLeft
            aria-hidden
            className={`size-4 transition-transform ${row.isExpanded ? "-rotate-90" : ""}`}
          />
        </button>
      ) : (
        <span aria-hidden className="grid size-6 shrink-0 place-items-center text-neutral-300">
          {row.treeDepth > 0 ? "•" : ""}
        </span>
      )}
      <span className="truncate" title={row.label}>
        {row.label}
      </span>
    </div>
  );
}

export default function SalesBreakdownReportPage() {
  const { start, end, tab, setTab } = useReportQueryState<never>({
    tab: { defaultValue: "status" },
  });
  const dimension = (tab as SalesBreakdownDimension) || "status";

  const [data, setData] = useState<SalesBreakdownResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default: the point of the tree is that the first screen is the
  // top-level picture. Keys are stale once the dimension or period changes, so
  // this resets alongside the fetch below.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setExpanded(new Set());
    getSalesBreakdown({ dimension, start, end })
      .then((res) => {
        if (active) setData(res);
      })
      .catch((err) => {
        if (active) setError(getUserFacingErrorMessage(err, "خطا در بارگذاری گزارش فروش"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dimension, start, end]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const isTree = dimension === "category" && hasHierarchy(rows);
  const tree = useMemo(() => (isTree ? buildCategoryTree(rows) : []), [isTree, rows]);
  const visibleRows = useMemo(
    () => (isTree ? flattenVisible(tree, expanded) : rows),
    [isTree, tree, expanded, rows],
  );

  const toggleRow = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const allExpandable = useMemo(() => (isTree ? expandableKeys(tree) : []), [isTree, tree]);
  const allExpanded = allExpandable.length > 0 && allExpandable.every((k) => expanded.has(k));
  const toggleAll = useCallback(() => {
    setExpanded(allExpanded ? new Set() : new Set(allExpandable));
  }, [allExpanded, allExpandable]);

  const columns = useMemo<ColumnDef<SalesBreakdownResponse["rows"][number]>[]>(
    () => [
      {
        accessorKey: "label",
        header: DIMENSION_LABELS[dimension],
        cell: ({ row }) =>
          isTree ? (
            <CategoryLabelCell row={row.original as FlatCategoryRow} onToggle={toggleRow} />
          ) : (
            row.original.label
          ),
      },
      {
        accessorKey: "ordersCount",
        header: "سفارش‌ها",
        cell: ({ getValue }) => faNum(getValue() as number),
      },
      {
        accessorKey: "units",
        header: "تعداد",
        cell: ({ getValue }) => faNum(getValue() as number),
      },
      {
        accessorKey: "grossToman",
        header: "فروش ناخالص (تومان)",
        cell: ({ getValue }) => priceFormatter(getValue() as number),
      },
      {
        accessorKey: "discountsToman",
        header: "تخفیف (تومان)",
        cell: ({ getValue }) => priceFormatter(getValue() as number),
      },
      {
        accessorKey: "refundsToman",
        header: "مرجوعی (تومان)",
        cell: ({ getValue }) => priceFormatter(getValue() as number),
      },
      {
        accessorKey: "netToman",
        header: "خالص فروش (تومان)",
        cell: ({ getValue }) => priceFormatter(getValue() as number),
      },
    ],
    [dimension, isTree, toggleRow],
  );

  // Deliberately the full row set, not the visible one: the chart ranks by net
  // across every depth and does not follow what is expanded.
  const chartRows = useMemo(() => rows.slice(0, CHART_TOP_N), [rows]);

  return (
    <SalesPage
      title="تفکیک فروش"
      description="فروش را بر اساس وضعیت سفارش، دسته‌بندی، مشتری، کد تخفیف یا استان مقایسه کنید."
    >
      <div className="space-y-6" dir="rtl">
        <div className="rounded-2xl bg-white p-5">
          <p className="text-xs text-neutral-500">
            برای فروش بر اساس تاریخ، محصول، مدل یا درگاه پرداخت به{" "}
            <Link href="/sales/products" className="text-infinity-primary hover:underline">
              گزارش فروش هر محصول
            </Link>{" "}
            مراجعه کنید.
          </p>
        </div>

        <div className="rounded-2xl bg-white p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {SALES_BREAKDOWN_DIMENSIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setTab?.(d)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                    dimension === d
                      ? "bg-infinity-primary text-white"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                  }`}
                >
                  {DIMENSION_LABELS[d]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {isTree && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="rounded-lg bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-200"
                >
                  {allExpanded ? "بستن همه" : "باز کردن همه"}
                </button>
              )}
              <ReportExportButton
                onExport={() => downloadSalesBreakdownExcel({ dimension, start, end })}
              />
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          {!loading && data?.ordersDefinition === "completed" && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
              در این بازه هیچ تراکنش موفق درگاهی ثبت نشده است، بنابراین این گزارش بر پایه سفارش‌های
              «تحویل شده» محاسبه شده و مبالغ تسویه‌نشده صفر در نظر گرفته شده‌اند.
            </div>
          )}

          {/*
            Same column label as «نمای کلی فروش», deliberately a different figure:
            shipping is an order-level charge and belongs to no status, category,
            customer, coupon or province, so it is never in this table (D16).
          */}
          <p className="mb-4 rounded-lg bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-600">
            «فروش ناخالص» این جدول فقط اقلام سفارش است و هزینه ارسال در آن نیست، چون هزینه ارسال به
            سفارش تعلق دارد نه به دسته یا محصول. در «نمای کلی فروش» هزینه ارسال به فروش ناخالص افزوده
            شده است، پس آن رقم به همان اندازه بزرگ‌تر است.
          </p>

          {isTree && (
            <p className="mb-4 rounded-lg bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-600">
              دسته‌های اصلی نمایش داده شده‌اند و عدد هر دسته شامل زیرمجموعه‌های آن هم هست. برای دیدن
              جزئیات، دسته را باز کنید. ردیف «(مستقیم)» فروشی است که روی خودِ آن دسته ثبت شده و در
              هیچ زیرمجموعه‌ای نیست. هر کالا در همهٔ دسته‌هایی که به آن اختصاص داده شده (دستهٔ اصلی و
              دسته‌های دیگر) شمرده می‌شود؛ بنابراین هیچ‌کدام از ستون‌ها جمع‌پذیر نیستند و جمع ردیف‌ها
              بیشتر از فروش کل می‌شود. عدد هر ردیف به‌تنهایی درست است و هر قلم فروش در هر دسته فقط
              یک‌بار حساب شده است.
            </p>
          )}

          {!loading && (data?.warnings?.length ?? 0) > 0 && (
            <div className="mb-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {data!.warnings!.map((warning) => (
                <p key={warning.code}>{warning.message}</p>
              ))}
            </div>
          )}

          {data?.truncated && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
              تعداد ردیف‌ها زیاد است؛ کمترین موارد در ردیف «سایر» جمع شده‌اند.
            </div>
          )}

          {!loading && dimension === "geography" ? (
            <SalesGeographyMap rows={data?.rows ?? []} />
          ) : null}

          {!loading && dimension !== "geography" && chartRows.length > 0 ? (
            <RankedBreakdownChart dimension={dimension} rows={chartRows} />
          ) : null}

          {/*
            The flattened visible rows are passed straight through: SuperAdminTable
            renders a supplied `data` array verbatim (its page/pageSize keys only
            slice its own fetch path), so a parent and its children can never end
            up separated.

            `getRowId` matters here: these rows carry `key`, not `id`, so without it
            the table falls back to the row INDEX — and every index below an
            expanded category shifts, which makes React reuse the wrong row.
          */}
          <SuperAdminTable
            columns={columns}
            data={visibleRows}
            getRowId={(row) => row.key}
            loading={loading}
          />
        </div>
      </div>
    </SalesPage>
  );
}
