"use client";

import { DatePicker } from "zaman";
import {
  previousJalaliMonthRange,
  thisJalaliMonthRange,
  toDateOnly,
} from "./reportDates";

const DAY_MS = 86_400_000;

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalizes whatever shape `zaman`'s <DatePicker onChange> hands back (a Date, a
 * `{ value: Date }` wrapper, or a parseable string) into a Date, falling back to the
 * previous value on anything unparseable. Previously copy-pasted into liquidity,
 * gateway-liquidity, traffic and admin-activity report pages.
 */
export function normalizeDateInput(value: unknown, previous: Date): Date {
  if (value == null) return previous;
  if (value instanceof Date) return isValidDate(value) ? value : previous;
  if (isRecord(value) && value.value instanceof Date) {
    return isValidDate(value.value) ? value.value : previous;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return isValidDate(parsed) ? parsed : previous;
  }
  return previous;
}

export interface DateRangePreset {
  label: string;
  getRange: () => { start: Date; end: Date };
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

export const DEFAULT_REPORT_DATE_PRESETS: DateRangePreset[] = [
  { label: "۷ روز گذشته", getRange: () => ({ start: daysAgo(7), end: new Date() }) },
  { label: "۳۰ روز گذشته", getRange: () => ({ start: daysAgo(30), end: new Date() }) },
  { label: "۹۰ روز گذشته", getRange: () => ({ start: daysAgo(90), end: new Date() }) },
  { label: "این ماه", getRange: () => thisJalaliMonthRange() },
  { label: "ماه گذشته", getRange: () => previousJalaliMonthRange() },
];

export interface ReportDateRangeFieldProps {
  start: Date;
  end: Date;
  onChange: (range: { start: Date; end: Date }) => void;
  presets?: DateRangePreset[] | false;
  className?: string;
}

const inputClass =
  "block w-full rounded-lg border border-neutral-300 px-3 py-2 transition-all focus:border-transparent focus:ring-2 focus:ring-infinity-primary";

const pickerShell =
  "w-full min-w-0 [&_input]:box-border [&_input]:block [&_input]:w-full";

/** Shared start/end date-range field (zaman DatePicker pair + quick presets) for report pages. */
export default function ReportDateRangeField({
  start,
  end,
  onChange,
  presets = DEFAULT_REPORT_DATE_PRESETS,
  className,
}: ReportDateRangeFieldProps) {
  return (
    <div className={className}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex min-w-0 w-full flex-col gap-2">
          <label className="text-sm font-medium text-neutral-600" htmlFor="report-start-date">
            تاریخ شروع
          </label>
          <div className={pickerShell}>
            <DatePicker
              // zaman's DatePicker is uncontrolled (`defaultValue` only, no `value` prop —
              // confirmed against the installed package's own type declarations). This field
              // has a second writer besides the picker itself (the presets below), so a `key`
              // keyed on the incoming value forces a remount whenever `start` changes
              // externally — otherwise the input would keep showing a stale date after a
              // preset click even though the report above it already refetched.
              key={toDateOnly(start)}
              defaultValue={start}
              locale="fa"
              direction="rtl"
              inputClass={inputClass}
              inputAttributes={{
                id: "report-start-date",
                "aria-label": "تاریخ شروع",
              }}
              onChange={(value) =>
                onChange({ start: normalizeDateInput(value, start), end })
              }
            />
          </div>
        </div>
        <div className="flex min-w-0 w-full flex-col gap-2">
          <label className="text-sm font-medium text-neutral-600" htmlFor="report-end-date">
            تاریخ پایان
          </label>
          <div className={pickerShell}>
            <DatePicker
              key={toDateOnly(end)}
              defaultValue={end}
              locale="fa"
              direction="rtl"
              inputClass={inputClass}
              inputAttributes={{
                id: "report-end-date",
                "aria-label": "تاریخ پایان",
              }}
              onChange={(value) =>
                onChange({ start, end: normalizeDateInput(value, end) })
              }
            />
          </div>
        </div>
      </div>
      {presets && presets.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => onChange(preset.getRange())}
              className="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600 transition hover:border-infinity-primary hover:text-infinity-primary"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
