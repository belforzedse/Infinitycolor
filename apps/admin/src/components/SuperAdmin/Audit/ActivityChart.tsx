"use client";

import { useId, useMemo, useState } from "react";
import { AdminCard, ChartSkeleton } from "@/components/admin";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/SuperAdmin/reports/shared/charts";
import {
  AXIS_COLOR,
  AXIS_TICK,
  CATEGORICAL_PALETTE,
  GRID_COLOR,
} from "@/components/SuperAdmin/reports/shared/chartTheme";
import { AnalyticsTable } from "@/components/SuperAdmin/reports/shared/AnalyticsTable";
import { ChartTableToggle } from "@/components/SuperAdmin/reports/shared/ChartTableToggle";
import {
  ChartTooltipCard,
  TOOLTIP_SURFACE,
  useTooltipEscape,
} from "@/components/SuperAdmin/reports/shared/ChartTooltip";
import { compactNumber, numberText, tehranToday } from "@/components/SuperAdmin/reports/shared/format";
import { DURATION, SWAP, usePrefersReducedMotion } from "@/components/SuperAdmin/reports/shared/motion";
import { SectionHeader } from "@/components/SuperAdmin/reports/shared/ui";
import type { AuditSummary } from "@/services/audit";
import { ACTIVITY_UNIT_LABEL, bucketActivity, type ActivityBucket } from "./activityBuckets";

/**
 * Admins and automatic runs, validated as a pair on the card surface: ΔE 29.7
 * for colour-blind readers, 32.7 for everyone else. The ochre sits below 3:1
 * against white, so both series are also named in the legend, the tooltip and
 * the table view.
 */
const HUMAN_COLOR = CATEGORICAL_PALETTE[0];
const AUTOMATIC_COLOR = CATEGORICAL_PALETTE[2];

function flagOf(bucket: ActivityBucket) {
  return bucket.incomplete ? "ناتمام" : bucket.partial ? "بخشی از بازه" : null;
}

function ActivityTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ActivityBucket }> }) {
  const bucket = payload?.[0]?.payload;
  if (!active || !bucket) return null;
  return (
    <div className={TOOLTIP_SURFACE}>
      <ChartTooltipCard
        title={bucket.title}
        flag={flagOf(bucket)}
        rows={[
          { key: "human", label: "اقدام‌های مدیران", value: numberText(bucket.human), color: HUMAN_COLOR },
          { key: "automatic", label: "اجراهای خودکار", value: numberText(bucket.automatic), color: AUTOMATIC_COLOR },
          { key: "total", label: "مجموع", value: numberText(bucket.human + bucket.automatic), muted: true },
        ]}
      />
    </div>
  );
}

/**
 * Activity over the selected range, admins stacked under automatic runs. The
 * whole range is always shown: a long one is bucketed by week or Jalali month
 * (the subtitle says which), never cut to its last days.
 */
export default function ActivityChart({
  summary,
  loading,
  range,
}: {
  summary: AuditSummary | null;
  loading: boolean;
  range: { start: string; end: string };
}) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const escape = useTooltipEscape();
  const reduced = usePrefersReducedMotion();
  const { unit, buckets } = useMemo(
    () => bucketActivity(summary?.series ?? [], range, tehranToday()),
    [summary, range],
  );
  const hasActivity = buckets.some((bucket) => bucket.human + bucket.automatic > 0);

  return (
    <AdminCard>
      <SectionHeader
        id="audit-chart-title"
        title="روند فعالیت در بازه انتخابی"
        description={`اقدام‌های مستقیم مدیران در کنار اجراهای خودکار؛ ${ACTIVITY_UNIT_LABEL[unit]}، کل بازه.`}
        actions={
          hasActivity ? (
            <ChartTableToggle showing={showTable} onToggle={() => setShowTable((shown) => !shown)} controls={tableId} />
          ) : null
        }
      />
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: HUMAN_COLOR }} />
          اقدام‌های مدیران
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: AUTOMATIC_COLOR }} />
          اجراهای خودکار
        </span>
      </div>
      <div className="mt-4" aria-busy={loading}>
        {loading && !summary ? (
          <ChartSkeleton className="h-56" />
        ) : !hasActivity ? (
          <p className="rounded-control border border-dashed border-slate-200 px-4 py-10 text-center text-xs text-slate-500">
            در این بازه فعالیتی ثبت نشده است.
          </p>
        ) : showTable ? (
          <div id={tableId} className={SWAP}>
            <AnalyticsTable
              caption="فعالیت مدیران و اجراهای خودکار در هر دوره"
              rows={buckets}
              rowKey={(bucket) => bucket.key}
              maxRows={200}
              dense
              minWidth={480}
              columns={[
                {
                  key: "title",
                  label: "دوره",
                  render: (bucket) => (
                    <span>
                      {bucket.title}
                      {flagOf(bucket) ? <span className="text-slate-500"> ({flagOf(bucket)})</span> : null}
                    </span>
                  ),
                },
                { key: "human", label: "مدیران", numeric: true, render: (bucket) => numberText(bucket.human), sortValue: (bucket) => bucket.human },
                {
                  key: "automatic",
                  label: "خودکار",
                  numeric: true,
                  render: (bucket) => numberText(bucket.automatic),
                  sortValue: (bucket) => bucket.automatic,
                },
                {
                  key: "total",
                  label: "مجموع",
                  numeric: true,
                  render: (bucket) => numberText(bucket.human + bucket.automatic),
                  sortValue: (bucket) => bucket.human + bucket.automatic,
                },
              ]}
            />
          </div>
        ) : (
          <div
            role="figure"
            aria-labelledby="audit-chart-title"
            aria-describedby={`${tableId}-hint`}
            className={loading ? "opacity-60 transition-opacity" : SWAP}
            {...escape.handlers}
          >
            <p id={`${tableId}-hint`} className="sr-only">
              با کلیدهای جهت‌نما بین دوره‌ها بروید؛ مقدارهای دقیق در «نمایش جدول» است.
            </p>
            <div className="h-56 md:h-64" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={buckets} margin={{ top: 8, right: 8, left: 4, bottom: 4 }} barCategoryGap="18%">
                  <CartesianGrid vertical={false} stroke={GRID_COLOR} />
                  <XAxis
                    dataKey="label"
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={{ stroke: AXIS_COLOR }}
                    interval="preserveStartEnd"
                    minTickGap={20}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    allowDecimals={false}
                    tickFormatter={(value: number) => compactNumber(value)}
                  />
                  <Tooltip
                    active={escape.active}
                    cursor={{ fill: "rgba(148, 163, 184, 0.12)" }}
                    animationDuration={DURATION.micro}
                    content={<ActivityTooltip />}
                  />
                  <Bar
                    dataKey="human"
                    stackId="activity"
                    fill={HUMAN_COLOR}
                    stroke="#ffffff"
                    strokeWidth={1}
                    name="اقدام‌های مدیران"
                    isAnimationActive={!reduced}
                    animationDuration={DURATION.chart}
                    animationEasing="ease-out"
                  />
                  <Bar
                    dataKey="automatic"
                    stackId="activity"
                    fill={AUTOMATIC_COLOR}
                    stroke="#ffffff"
                    strokeWidth={1}
                    radius={[3, 3, 0, 0]}
                    name="اجراهای خودکار"
                    isAnimationActive={!reduced}
                    animationBegin={120}
                    animationDuration={DURATION.chart}
                    animationEasing="ease-out"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    </AdminCard>
  );
}
