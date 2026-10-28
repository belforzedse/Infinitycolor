"use client";

import { useState } from "react";
import { Radio } from "lucide-react";
import { FOCUS_RING } from "@/components/admin";
import { cn } from "@/utils/tailwind";
import { dateTimeText, finite, numberText } from "@/components/SuperAdmin/reports/shared/format";
import { presentAnalyticsMessage, presentPath } from "../presentation";
import { useRealtime } from "./useBehaviorData";

type Page = { path?: string; visitors?: number | null };

/**
 * Live visitors as a small operational indicator: useful, never the top of
 * the page. Expanding it lists the active pages and polls more often.
 */
export function useRealtimePill() {
  const [expanded, setExpanded] = useState(false);
  const realtime = useRealtime(expanded);
  const data = (realtime.report?.data ?? null) as { activeVisitors?: unknown; topPages?: Page[] } | null;
  const active = finite(data?.activeVisitors);
  const unavailable = !realtime.loading && (realtime.report?.state === "unavailable" || realtime.requestError);

  const pill = (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls="traffic-realtime"
      onClick={() => setExpanded((value) => !value)}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-control border border-slate-200 bg-white px-3 text-xs font-medium text-slate-800 hover:border-slate-300",
        FOCUS_RING,
      )}
    >
      <Radio aria-hidden className={cn("size-3.5", active ? "text-emerald-700" : "text-slate-400")} />
      {unavailable
        ? "آمار لحظه‌ای در دسترس نیست"
        : active === null
          ? "اکنون در سایت: —"
          : `${numberText(active)} نفر اکنون در سایت`}
    </button>
  );

  const panel = expanded ? (
    <section
      id="traffic-realtime"
      aria-label="آمار لحظه‌ای"
      className="rounded-prominent border border-slate-100 bg-white p-4 shadow-sm md:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">
          فعال در ۳۰ دقیقه اخیر: {numberText(active)} بازدیدکننده
        </h3>
        <p className="text-[11px] text-slate-600">
          هر ۳۰ ثانیه، فقط وقتی این صفحه باز است · {dateTimeText(realtime.report?.metadata.refreshedAt)}
        </p>
      </div>
      {unavailable ? (
        <p className="mt-2 text-xs text-amber-800">
          {presentAnalyticsMessage(realtime.requestError ?? realtime.report?.error ?? "realtime unavailable")}
        </p>
      ) : (
        <ol className="mt-3 grid gap-x-8 gap-y-1.5 text-xs md:grid-cols-2">
          {(data?.topPages ?? []).slice(0, 10).map((page, index) => (
            <li key={`${page.path}-${index}`} className="flex items-center justify-between gap-3 border-b border-slate-100 py-1">
              <span className="min-w-0 truncate text-slate-800" title={page.path}>
                {presentPath(page.path)}
              </span>
              <span className="shrink-0 tabular-nums text-slate-700">{numberText(page.visitors)}</span>
            </li>
          ))}
          {!(data?.topPages ?? []).length ? (
            <li className="text-slate-600">صفحه فعالی در این لحظه نیست.</li>
          ) : null}
        </ol>
      )}
    </section>
  ) : null;

  return { pill, panel, lastRefresh: realtime.report?.metadata.refreshedAt ?? null };
}
