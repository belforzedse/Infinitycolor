"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type {
  LiquidityInterval,
  LiquidityResult,
} from "@/services/super-admin/reports/liquidity";
import { getLiquidity } from "@/services/super-admin/reports/liquidity";
import {
  getGatewayLiquidity,
  type GatewayLiquidityResult,
} from "@/services/super-admin/reports/gatewayLiquidity";
import SalesPage from "../_components/SalesPage";
import GatewayBreakdownTable from "@/components/SuperAdmin/reports/shared/GatewayBreakdownTable";
import MetricFormula from "@/components/SuperAdmin/reports/shared/MetricFormula";
import ReportNotes from "@/components/SuperAdmin/reports/products/ReportNotes";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import { AdminSection, ChartSkeleton, EmptyState, ErrorState } from "@/components/admin";
import { useReportQueryState } from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import KpiCard from "@/components/SuperAdmin/reports/shared/KpiCard";
import { DeltaBadge } from "@/components/SuperAdmin/reports/shared/DeltaBadge";
import { ChartTableToggle } from "@/components/SuperAdmin/reports/shared/ChartTableToggle";
import TimeSeriesChart, { SeriesLegend } from "@/components/SuperAdmin/reports/shared/TimeSeriesChart";
import { Notice } from "@/components/SuperAdmin/reports/shared/ui";
import {
  NO_COMPARISON_BEFORE_FLOOR,
  comparablePrevious,
  salesSeriesRows,
} from "@/components/SuperAdmin/reports/shared/salesSeries";
import {
  compactNumber,
  numberText,
  rangeText,
  relativeChange,
  tehranToday,
  tomanText,
} from "@/components/SuperAdmin/reports/shared/format";

const INTERVAL_OPTIONS: { id: LiquidityInterval; label: string }[] = [
  { id: "day", label: "روزانه" },
  { id: "week", label: "هفتگی" },
  { id: "month", label: "ماهانه" },
];

/**
 * Without a successful gateway settlement in the window the server falls
 * back to delivered orders, and none of those orders has a recorded payment:
 * their cash is unknown, not zero.
 */
function cashUnknown(result: LiquidityResult | null) {
  return result?.ordersDefinition === "completed";
}

export default function LiquidityReportPage() {
  // The period comes from the workspace layout via shared nuqs state, so it
  // survives navigation between sales subpages and is shareable as a URL.
  const { start, end, values, setValues } = useReportQueryState<"interval">({
    tab: false,
    extraKeys: ["interval"],
  });
  const interval = (values.interval || "day") as LiquidityInterval;
  const previousRange = useMemo(() => comparablePrevious({ start, end }), [start, end]);

  const [data, setData] = useState<LiquidityResult | null>(null);
  const [previous, setPrevious] = useState<LiquidityResult | null>(null);
  const [gateways, setGateways] = useState<GatewayLiquidityResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setGatewayError(null);
    const range = { start, end };
    Promise.allSettled([
      getLiquidity({ ...range, interval }),
      getGatewayLiquidity(range),
      // The same series for the window just before, only where sales data exists.
      previousRange ? getLiquidity({ ...previousRange, interval }) : Promise.resolve(null),
    ])
      .then(([liquidityResult, gatewayResult, previousResult]) => {
        if (!active) return;
        if (liquidityResult.status === "fulfilled") {
          setData(liquidityResult.value);
        } else {
          setData(null);
          setError(getUserFacingErrorMessage(liquidityResult.reason, "خطا در بارگذاری نقدینگی"));
        }
        setPrevious(previousResult.status === "fulfilled" ? previousResult.value : null);
        if (gatewayResult.status === "fulfilled") {
          setGateways(gatewayResult.value);
        } else {
          setGateways(null);
          setGatewayError(getUserFacingErrorMessage(gatewayResult.reason, "تفکیک درگاه‌ها در دسترس نیست"));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end, interval, previousRange, reloadKey]);

  const unknown = cashUnknown(data);
  const comparable = Boolean(previousRange && previous && !cashUnknown(previous));
  const today = tehranToday();

  return (
    <SalesPage
      title="مجموع نقدینگی"
      actions={
        <div className="flex items-center gap-2">
          <label className="text-xs shrink-0 text-neutral-500" htmlFor="liquidity-interval">
            بازه زمانی
          </label>
          <select
            id="liquidity-interval"
            className="text-sm h-11 rounded-lg border border-neutral-300 bg-white px-3 focus:border-transparent focus:ring-2 focus:ring-infinity-primary md:h-10"
            value={interval}
            onChange={(e) => setValues({ interval: e.target.value, page: "1" })}
          >
            {INTERVAL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {error ? (
        <ErrorState description={error} onRetry={() => setReloadKey((key) => key + 1)} />
      ) : loading && !data ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiCard title="مجموع نقدینگی" loading />
            <KpiCard title="سفارش‌های پرداخت‌شده" loading />
          </div>
          <ChartSkeleton />
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiCard
              title="مجموع نقدینگی"
              amount={unknown ? undefined : (data?.total ?? null)}
              value={unknown ? <span className="text-base font-medium text-amber-800 md:text-lg">نامعلوم</span> : undefined}
              format={tomanText}
              delta={
                unknown ? null : (
                  <DeltaBadge
                    change={comparable ? relativeChange(data?.total, previous?.total) : null}
                    noComparisonText={previousRange ? "بدون مبنای مقایسه" : NO_COMPARISON_BEFORE_FLOOR}
                  />
                )
              }
              previous={comparable && !unknown ? tomanText(previous?.total) : null}
              context={unknown ? "برای سفارش‌های این بازه پرداخت موفقی از درگاه ثبت نشده است." : null}
              info="پول واقعی دریافتی سفارش‌های پرداخت‌شده بر پایه تاریخ پرداخت: شامل هزینه ارسال و خالص از مرجوعی. با «فروش ناخالص» در نمای کلی فروش برابر نیست؛ آن رقم هم هزینه ارسال را دارد اما پیش از کسر تخفیف و بر پایه تاریخ ثبت سفارش است."
              incomplete={end >= today}
              order={0}
            />
            <KpiCard
              title={unknown ? "سفارش‌های تحویل‌شده" : "سفارش‌های پرداخت‌شده"}
              amount={data?.ordersCount ?? null}
              format={(value) => numberText(value)}
              delta={
                <DeltaBadge
                  change={comparable ? relativeChange(data?.ordersCount, previous?.ordersCount) : null}
                  noComparisonText={previousRange ? "بدون مبنای مقایسه" : NO_COMPARISON_BEFORE_FLOOR}
                />
              }
              previous={comparable ? numberText(previous?.ordersCount) : null}
              incomplete={end >= today}
              order={1}
            />
          </div>
          {unknown ? (
            <Notice tone="warning">
              در این بازه هیچ پرداخت موفقی از درگاه ثبت نشده است؛ به‌جای آن سفارش‌های «در حال انجام یا
              تحویل‌شده» شمرده شده‌اند. مبلغ دریافتی این سفارش‌ها نامعلوم است و در نمودار خالی مانده، نه صفر.
            </Notice>
          ) : null}
          <LiquidityTrend
            data={data}
            previous={comparable ? previous : null}
            previousRange={comparable ? previousRange : null}
            beforeFloor={!previousRange}
            range={{ start, end }}
            interval={interval}
            loading={loading}
            today={today}
          />
          <GatewayLiquiditySection data={gateways} error={gatewayError} />
        </>
      )}
    </SalesPage>
  );
}

function LiquidityTrend({
  data,
  previous,
  previousRange,
  beforeFloor,
  range,
  interval,
  loading,
  today,
}: {
  data: LiquidityResult | null;
  previous: LiquidityResult | null;
  previousRange: { start: string; end: string } | null;
  /** The previous window starts before sales data exists. */
  beforeFloor: boolean;
  range: { start: string; end: string };
  interval: LiquidityInterval;
  loading: boolean;
  today: string;
}) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const unknown = cashUnknown(data);
  const rows = useMemo(() => {
    if (!data?.series?.length) return null;
    return salesSeriesRows({
      points: data.series,
      grouping: data.interval ?? interval,
      range,
      today,
      value: (point) => point.total,
      unknownReason: (point) =>
        unknown && point.orders > 0
          ? `${numberText(point.orders)} سفارش تحویل‌شده؛ مبلغ دریافتی ثبت نشده`
          : null,
      previousPoints: previous?.series ?? null,
      previousRange,
    });
  }, [data, previous, previousRange, range, interval, today, unknown]);

  return (
    <AdminSection
      title="روند نقدینگی"
      description="بر پایه تاریخ پرداخت است، نه تاریخ ثبت سفارش؛ همان سری «روند» گزارش محصولات با ساعت پرداخت."
      actions={
        rows ? (
          <ChartTableToggle showing={showTable} onToggle={() => setShowTable((shown) => !shown)} controls={tableId} />
        ) : null
      }
    >
      <div className="space-y-4">
        {rows ? (
          <SeriesLegend
            current={`این دوره: ${rangeText(range.start, range.end)}`}
            previous={previousRange ? `دوره قبل: ${rangeText(previousRange.start, previousRange.end)}` : null}
            incomplete={rows.some((row) => row.incomplete)}
          >
            {beforeFloor ? (
              <span className="text-slate-500">مقایسه با دوره قبل نیست: دوره قبل پیش از ۲۳ شهریور است.</span>
            ) : null}
          </SeriesLegend>
        ) : null}
        {rows ? (
          <TimeSeriesChart
            rows={rows}
            seriesLabel="نقدینگی"
            valueText={tomanText}
            axisText={(value) => compactNumber(value)}
            loading={loading}
            view={showTable ? "table" : "chart"}
            tableId={tableId}
            heightClass="h-[260px] md:h-[340px]"
            yAxisWidth={76}
            gradientId="liquidity-trend-fill"
            emptyText={unknown ? "مبلغ دریافتی این بازه ثبت نشده است." : undefined}
          />
        ) : (
          <EmptyState title="داده‌ای برای نمایش یافت نشد" description="لطفاً بازه زمانی دیگری انتخاب کنید" />
        )}
      </div>
    </AdminSection>
  );
}

function GatewayLiquiditySection({
  data,
  error,
}: {
  data: GatewayLiquidityResult | null;
  error: string | null;
}) {
  const rows = data?.rows ?? [];
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  // `undefined` = the API does not send the term yet; `0` = shipping really was
  // free. Only the second can be put in an equation.
  //
  // `shipping <= total` is the other guard: on a window that fell back to the
  // "completed" definition there is no settled cash at all, so `total` is 0 (or
  // below shipping) and the subtraction would render a negative «فروش کالا».
  const shipping = data?.shippingRevenue;
  const canReconcile =
    typeof shipping === "number" && Number.isFinite(shipping) && total > 0 && shipping <= total;
  return (
    <div id="gateways">
      <AdminSection
        title="دریافتی درگاه‌های پرداخت"
        description="همان جدول «پرداخت و ارسال» گزارش محصولات؛ سفارش‌های ترکیبی (کیف پول + درگاه) زیر هر دو کانال دیده می‌شوند."
      >
        {error ? (
          <Notice tone="warning">{error}</Notice>
        ) : rows.length === 0 ? (
          <EmptyState title="تراکنش موفقی برای تفکیک درگاه‌ها وجود ندارد" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <KpiCard title="مجموع دریافتی درگاه‌ها" amount={total} format={tomanText} order={0} />
              <KpiCard
                title="درگاه‌های فعال"
                amount={rows.filter((row) => Number(row.total) > 0).length}
                format={(value) => numberText(value)}
                order={1}
              />
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-100 bg-white p-4">
              <GatewayBreakdownTable rows={rows} totalSales={total} ordersCount={data?.paidOrdersCount ?? 0} />
            </div>
            {/*
              Both terms come from this one endpoint and the one `paid_orders`
              set, so the arithmetic is exact. The relationship to «فروش ناخالص»
              on the overview is NOT exact — it is counted on the order date —
              so it stays in the note, out of the equation.
            */}
            {canReconcile && (
              <MetricFormula
                terms={[
                  { label: "مجموع دریافتی درگاه‌ها", value: total },
                  { label: "هزینه ارسال", value: shipping, op: "−" },
                ]}
                result={{ label: "فروش کالا (بدون ارسال)", value: total - shipping }}
                note={
                  <>
                    «دریافتی درگاه‌ها» پولی است که واقعاً در درگاه نشسته، پس هزینه ارسال را هم در بر
                    می‌گیرد؛ «فروش ناخالص» در «نمای کلی فروش» هم هزینه ارسال را دارد، اما پیش از کسر
                    تخفیف است. رقم سمت راست این تساوی، فروش کالا بدون ارسال، همان چیزی است که با
                    «فروش خالص» آن صفحه سنجیده می‌شود. این دو بر پایه دو تاریخ متفاوت شمرده می‌شوند
                    — اینجا تاریخ پرداخت، آنجا تاریخ ثبت سفارش — بنابراین سفارشی که پرداختش به بازه
                    بعد افتاده، تفاوت کوچکی باقی می‌گذارد.
                  </>
                }
              />
            )}
            <ReportNotes warnings={data?.dataQualityWarnings} />
          </div>
        )}
      </AdminSection>
    </div>
  );
}
