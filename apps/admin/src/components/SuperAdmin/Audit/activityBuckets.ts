import { addDays, bucketSpanText, dateText } from "@/components/SuperAdmin/reports/shared/format";
import { jalaliPartsInTehran } from "@/components/SuperAdmin/reports/shared/reportDates";

export type ActivityUnit = "day" | "week" | "month";

export type ActivityBucket = {
  key: string;
  first: string;
  last: string;
  /** Short axis label. */
  label: string;
  /** The days it covers, in words. */
  title: string;
  human: number;
  automatic: number;
  /** The range holds only part of this week or month. */
  partial: boolean;
  /** Contains today: its count will still grow. */
  incomplete: boolean;
};

export const ACTIVITY_UNIT_LABEL: Record<ActivityUnit, string> = {
  day: "روزانه",
  week: "هفتگی (از شنبه)",
  month: "ماهانه (ماه شمسی)",
};

/** Up to two months stays daily; up to half a year goes weekly; longer goes monthly. */
export function activityUnit(dayCount: number): ActivityUnit {
  if (dayCount <= 62) return "day";
  if (dayCount <= 182) return "week";
  return "month";
}

function noon(ymd: string) {
  return new Date(`${ymd}T12:00:00+03:30`);
}

function jalaliMonthKey(ymd: string) {
  const parts = jalaliPartsInTehran(noon(ymd));
  return parts ? `${parts.year}-${String(parts.month).padStart(2, "0")}` : ymd.slice(0, 7);
}

const JALALI_MONTH = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  timeZone: "Asia/Tehran",
  month: "long",
  year: "numeric",
});

/**
 * The daily activity series over the WHOLE selected range: days the log has
 * no events for are real zeros (the log is complete for its window), and a
 * long range is bucketed into Saturday-start weeks or Jalali months instead
 * of being cut to its last days. Edge buckets the range only partly covers
 * are flagged, and so is the bucket holding today.
 */
export function bucketActivity(
  series: ReadonlyArray<{ date: string; human: number; automatic: number }>,
  range: { start: string; end: string },
  today: string,
): { unit: ActivityUnit; buckets: ActivityBucket[] } {
  if (!range.start || !range.end || range.start > range.end) return { unit: "day", buckets: [] };
  const byDate = new Map(series.map((point) => [point.date, point]));
  const days: string[] = [];
  for (let day = range.start; day <= range.end && days.length < 3700; day = addDays(day, 1)) days.push(day);
  const unit = activityUnit(days.length);

  const keyOf = (day: string) => {
    if (unit === "day") return day;
    if (unit === "week") return addDays(day, -((noon(day).getUTCDay() + 1) % 7));
    return jalaliMonthKey(day);
  };

  const buckets = new Map<string, ActivityBucket>();
  for (const day of days) {
    const key = keyOf(day);
    const point = byDate.get(day);
    const bucket =
      buckets.get(key) ??
      ({ key, first: day, last: day, label: "", title: "", human: 0, automatic: 0, partial: false, incomplete: false } as ActivityBucket);
    bucket.last = day;
    bucket.human += point?.human ?? 0;
    bucket.automatic += point?.automatic ?? 0;
    buckets.set(key, bucket);
  }

  return {
    unit,
    buckets: [...buckets.values()].map((bucket) => {
      const partial =
        unit === "week"
          ? bucket.first !== bucket.key || addDays(bucket.key, 6) !== bucket.last
          : unit === "month"
            ? jalaliMonthKey(addDays(bucket.first, -1)) === bucket.key ||
              jalaliMonthKey(addDays(bucket.last, 1)) === bucket.key
            : false;
      return {
        ...bucket,
        label: unit === "month" ? JALALI_MONTH.format(noon(bucket.first)) : dateText(bucket.first, false),
        title: bucketSpanText(bucket.first, bucket.last),
        partial,
        incomplete: bucket.first <= today && today <= bucket.last,
      };
    }),
  };
}
