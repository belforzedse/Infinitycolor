"use client";

import { useEffect, useState } from "react";
import { faNum } from "@/utils/faNum";
import { CARD, ErrorState } from "@/components/admin";
import { cn } from "@/utils/tailwind";
import { getProductOverview, type ProductOverview } from "@/services/super-admin/reports/products";
import KpiCard, { periodFigure } from "../shared/KpiCard";
import { numberText, tehranToday, tomanText } from "../shared/format";
import { NO_COMPARISON_BEFORE_FLOOR, previousWasClipped } from "../shared/salesSeries";
import ReportNotes from "./ReportNotes";

export default function OverviewTab({ start, end }: { start: string; end: string }) {
  const [data, setData] = useState<ProductOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getProductOverview({ start, end })
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e?.message || "خطا در دریافت اطلاعات"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [start, end, reloadKey]);

  if (error) {
    return <ErrorState description={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  }

  const k = data?.kpis;
  const inv = data?.inventory;
  const comparable = Boolean(data && !previousWasClipped(data.range ?? { start, end }, data.previous));
  const figure = (
    delta: Parameters<typeof periodFigure>[0],
    money: boolean,
    options: { lowerIsBetter?: boolean; neutral?: boolean } = {},
  ) =>
    periodFigure(delta, {
      format: money ? tomanText : (value) => numberText(value),
      comparable,
      noComparisonText: NO_COMPARISON_BEFORE_FLOOR,
      ...options,
    });
  const incomplete = end >= tehranToday();

  return (
    <div className="space-y-6" dir="rtl">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="فروش ناخالص محصولات"
          {...figure(k?.gross, true)}
          loading={loading}
          incomplete={incomplete}
          info="مجموع قیمت اقلام فروخته‌شده (بدون حمل و مالیات)."
          order={0}
        />
        <KpiCard
          title="خالص فروش"
          {...figure(k?.net, true)}
          loading={loading}
          incomplete={incomplete}
          estimate
          info="ناخالص منهای تخفیف و مرجوعی (تسهیم‌شده)."
          order={1}
        />
        <KpiCard title="تعداد فروش" {...figure(k?.units, false)} loading={loading} incomplete={incomplete} order={2} />
        <KpiCard
          title="سفارش‌های پرداخت‌شده"
          {...figure(k?.orders, false)}
          loading={loading}
          incomplete={incomplete}
          info="سفارش‌هایی با تسویه موفق در بازه."
          order={3}
        />
        <KpiCard
          title="قیمت میانگین فروش"
          {...figure(k?.avgPrice, true, { neutral: true })}
          loading={loading}
          order={4}
        />
        <KpiCard
          title="میانگین ارزش سفارش"
          {...figure(k?.aov, true)}
          loading={loading}
          info="بر مبنای فروش ناخالص محصولات."
          order={5}
        />
        <KpiCard
          title="تخفیف‌ها"
          {...figure(k?.discounts, true, { neutral: true })}
          loading={loading}
          info="تخفیف در سطح سفارش."
          order={6}
        />
        <KpiCard
          title="مرجوعی‌ها"
          {...figure(k?.refunds, true, { lowerIsBetter: true })}
          loading={loading}
          estimate
          info="تراکنش‌های بازگشتی موفق."
          order={7}
        />
      </div>

      <div>
        <h3 className="mb-3 text-base font-medium text-neutral-700">وضعیت موجودی</h3>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <InvBox label="محصولات فعال" value={inv?.activeProducts} loading={loading} />
          <InvBox label="کل تنوع‌ها" value={inv?.totalVariations} loading={loading} />
          <InvBox label="موجود" value={inv?.inStock} loading={loading} tone="green" />
          <InvBox
            label={`کم‌موجود (≤${faNum(data?.lowStockThreshold ?? 5)})`}
            value={inv?.lowStock}
            loading={loading}
            tone="amber"
          />
          <InvBox label="ناموجود" value={inv?.outStock} loading={loading} tone="red" />
        </div>
      </div>

      {!loading && data && (
        <ReportNotes
          note={`${data.notes?.net ?? ""} ${data.notes?.refunds ?? ""} ارقام به تومان و بر مبنای «سفارش‌های پرداخت‌شده، خالص از مرجوعی» محاسبه شده‌اند.`}
        />
      )}
    </div>
  );
}

function InvBox({
  label,
  value,
  loading,
  tone = "neutral",
}: {
  label: string;
  value?: number;
  loading?: boolean;
  tone?: "neutral" | "green" | "amber" | "red";
}) {
  const toneCls = {
    neutral: "text-neutral-800",
    green: "text-emerald-700",
    amber: "text-amber-700",
    red: "text-rose-700",
  }[tone];
  return (
    <div className={cn(CARD, "p-4")}>
      <p className="mb-2 text-xs text-slate-600">{label}</p>
      {loading ? (
        <div className="h-6 w-12 animate-pulse rounded bg-neutral-100" />
      ) : (
        <p className={`text-xl font-semibold tabular-nums ${toneCls}`}>{value === undefined ? "—" : faNum(value)}</p>
      )}
    </div>
  );
}
