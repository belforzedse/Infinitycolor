"use client";

import { useEffect, useState } from "react";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import { useReportQueryState } from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import { toDateOnly, parseDateOnly } from "@/components/SuperAdmin/reports/shared/reportDates";
import { getFunnel, type FunnelResponse, type FunnelStep } from "@/services/super-admin/reports/funnel";
import { faNum } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

const STEP_LABELS_FA: Record<FunnelStep, string> = {
  view_item: "مشاهده محصول",
  add_to_cart: "افزودن به سبد خرید",
  begin_checkout: "شروع تسویه‌حساب",
  purchase: "خرید",
};

export default function FunnelReportPage() {
  const { start, end, setRange } = useReportQueryState<never>({ tab: false });
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getFunnel({ start, end })
      .then((res) => {
        if (active) setData(res);
      })
      .catch((err) => {
        if (active) setError(getUserFacingErrorMessage(err, "خطا در بارگذاری قیف فروش"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end]);

  const maxCount = data?.steps.reduce((max, s) => Math.max(max, s.count), 0) ?? 0;

  return (
    <ContentWrapper title="قیف فروش">
      <div className="space-y-6" dir="rtl">
        <div className="rounded-2xl bg-white p-5">
          <ReportDateRangeField
            start={parseDateOnly(start)}
            end={parseDateOnly(end)}
            onChange={(range) =>
              setRange({ start: toDateOnly(range.start), end: toDateOnly(range.end) })
            }
          />
        </div>

        <div className="rounded-2xl bg-white p-5">
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          {!loading && data && !data.configured && (
            <div className="mb-4 rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
              ماتومو پیکربندی نشده یا در دسترس نیست — داده قیف فروش موجود نیست.
            </div>
          )}

          {data?.note && (
            <p className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-xs text-amber-700">{data.note}</p>
          )}

          {!loading && data?.configured && (
            <div className="space-y-3">
              {data.steps.map((step) => {
                const widthPct = maxCount > 0 ? Math.max(4, (step.count / maxCount) * 100) : 0;
                return (
                  <div key={step.step}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium text-neutral-700">{STEP_LABELS_FA[step.step]}</span>
                      <span className="text-neutral-500">
                        {faNum(step.count)}
                        {step.conversionFromPrevious !== null && (
                          <span className="mr-2 text-xs text-neutral-400">
                            ({faNum(step.conversionFromPrevious)}٪ از مرحله قبل)
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-6 w-full overflow-hidden rounded-lg bg-neutral-100">
                      <div
                        className="h-full rounded-lg bg-infinity-primary transition-all"
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </ContentWrapper>
  );
}
