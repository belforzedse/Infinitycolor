"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { AdminCard, ErrorState } from "@/components/admin";
import {
  getProductTrends,
  type ProductTrends,
  type TrendGrouping,
  type TrendPoint,
} from "@/services/super-admin/reports/products";
import { ChartTableToggle } from "../shared/ChartTableToggle";
import TimeSeriesChart, { SeriesLegend } from "../shared/TimeSeriesChart";
import { numberText, rangeText, tehranToday, tomanText } from "../shared/format";
import { salesSeriesRows } from "../shared/salesSeries";
import { Notice, SectionHeader, Segmented } from "../shared/ui";

type Metric = "net" | "gross" | "units" | "orders" | "discounts" | "refunds";

const METRICS: Array<{ id: Metric; label: string; money: boolean; description: string }> = [
  { id: "net", label: "خالص فروش", money: true, description: "فروش اقلام منهای تخفیف و مرجوعی، به تومان." },
  { id: "gross", label: "فروش ناخالص", money: true, description: "مجموع قیمت اقلام فروخته‌شده، بدون هزینه ارسال." },
  { id: "units", label: "تعداد فروش", money: false, description: "تعداد کالاهای فروخته‌شده." },
  { id: "orders", label: "سفارش‌ها", money: false, description: "سفارش‌های پرداخت‌شده، به تاریخ ثبت سفارش." },
  { id: "discounts", label: "تخفیف‌ها", money: true, description: "تخفیف در سطح سفارش." },
  { id: "refunds", label: "مرجوعی‌ها", money: true, description: "تراکنش‌های بازگشتی موفق." },
];

const GROUPINGS: Array<{ key: TrendGrouping; label: string }> = [
  { key: "day", label: "روزانه" },
  { key: "week", label: "هفتگی" },
  { key: "month", label: "ماهانه" },
];

/**
 * With no gateway settlement in the window the report counts delivered
 * orders instead, and none of them has a payment record, so their refunds
 * are unknown. Everything else (items, units, orders, discounts) comes from
 * the orders themselves and is real.
 */
function refundsUnknown(data: ProductTrends | null, point: TrendPoint) {
  return data?.ordersDefinition === "completed" && point.orders > 0;
}

export default function TrendsTab({ start, end }: { start: string; end: string }) {
  const [metric, setMetric] = useState<Metric>("net");
  const [grouping, setGrouping] = useState<TrendGrouping | "">("");
  const [data, setData] = useState<ProductTrends | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getProductTrends({ start, end, grouping: grouping || undefined })
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e?.message || "خطا در دریافت اطلاعات"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [start, end, grouping, reloadKey]);

  const definition = METRICS.find((m) => m.id === metric) ?? METRICS[0];
  const completed = data?.ordersDefinition === "completed";
  const rows = useMemo(() => {
    if (!data?.series?.length) return null;
    return salesSeriesRows({
      points: data.series,
      grouping: data.grouping,
      // The requested window; the server sends its bounds as UTC instants.
      range: { start, end },
      today: tehranToday(),
      value: (point) => point[metric],
      unknownReason: (point) =>
        metric === "refunds" && refundsUnknown(data, point)
          ? `${numberText(point.orders)} سفارش بدون ثبت پرداخت؛ مرجوعی نامعلوم`
          : null,
      note: (point) =>
        metric === "net" && refundsUnknown(data, point) ? "مرجوعی ثبت نشده؛ خالص بدون کسر مرجوعی" : null,
    });
  }, [data, metric, start, end]);

  return (
    <AdminCard>
      <div className="space-y-4" dir="rtl">
        <SectionHeader
          title="روند فروش"
          description={definition.description}
          actions={
            <>
              <Segmented
                label="شاخص نمودار روند"
                value={metric}
                options={METRICS.map(({ id, label }) => ({ id, label }))}
                onChange={setMetric}
                size="sm"
              />
              <label className="flex items-center gap-2 text-xs text-slate-600">
                گروه‌بندی
                <select
                  className="h-9 rounded-control border border-slate-200 bg-white px-2 text-sm text-slate-800"
                  value={grouping}
                  onChange={(e) => setGrouping(e.target.value as TrendGrouping | "")}
                >
                  <option value="">خودکار</option>
                  {GROUPINGS.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>
              {rows ? (
                <ChartTableToggle
                  showing={showTable}
                  onToggle={() => setShowTable((shown) => !shown)}
                  controls={tableId}
                />
              ) : null}
            </>
          }
        />

        {error ? (
          <ErrorState description={error} onRetry={() => setReloadKey((k) => k + 1)} />
        ) : (
          <>
            {completed ? (
              <Notice tone="warning">
                در این بازه هیچ پرداخت موفقی از درگاه ثبت نشده است؛ نمودار بر پایه سفارش‌های «تحویل‌شده»
                است. فروش، تعداد، سفارش و تخفیف واقعی‌اند، اما مرجوعی این سفارش‌ها ثبت نشده: در نمودار
                مرجوعی خالی مانده و «خالص» بدون کسر مرجوعی است.
              </Notice>
            ) : null}
            {rows?.length === 1 ? (
              <Notice>
                فقط یک بازه زمانی داده دارد، به همین دلیل نمودار تنها یک نقطه نشان می‌دهد. بازه بزرگ‌تری
                انتخاب کنید یا گروه‌بندی را تغییر دهید.
              </Notice>
            ) : null}
            {rows ? (
              <SeriesLegend
                current={`${definition.label}: ${rangeText(start, end)}`}
                incomplete={rows.some((row) => row.incomplete)}
              />
            ) : null}
            <TimeSeriesChart
              rows={rows}
              seriesLabel={definition.label}
              valueText={definition.money ? tomanText : (value) => numberText(value)}
              loading={loading}
              view={showTable ? "table" : "chart"}
              tableId={tableId}
              heightClass="h-[300px] md:h-[380px]"
              yAxisWidth={definition.money ? 76 : 48}
              gradientId="product-trend-fill"
              emptyText="داده‌ای برای این بازه ثبت نشده است. بازه زمانی دیگری انتخاب کنید."
            />
          </>
        )}
      </div>
    </AdminCard>
  );
}
