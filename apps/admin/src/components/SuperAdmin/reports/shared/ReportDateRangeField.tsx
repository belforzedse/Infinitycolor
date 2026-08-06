"use client";

import { DatePicker } from "zaman";
import { toDateOnly } from "./reportDates";

const DAY_MS = 86_400_000;

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && !isNaN(d.getTime());
}

/**
 * Normalizes whatever shape `zaman`'s <DatePicker onChange> hands back (a Date, a
 * `{ value: Date }` wrapper, or a parseable string) into a Date, falling back to the
 * previous value on anything unparseable. Previously copy-pasted into liquidity,
 * gateway-liquidity, traffic and admin-activity report pages.
 */
export function normalizeDateInput(value: unknown, previous: Date): Date {
  if (value == null) return previous;
  if (value instanceof Date) return value;
  if (typeof value === "object" && (value as any).value instanceof Date) {
    return (value as any).value;
  }
  const parsed = new Date(value as any);
  return isValidDate(parsed) ? parsed : previous;
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
  {
    label: "این ماه",
    getRange: () => {
      const now = new Date();
      return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
    },
  },
  {
    label: "ماه گذشته",
    getRange: () => {
      const now = new Date();
      return {
        start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        end: new Date(now.getFullYear(), now.getMonth(), 0),
      };
    },
  },
];

export interface ReportDateRangeFieldProps {
  start: Date;
  end: Date;
  onChange: (range: { start: Date; end: Date }) => void;
  presets?: DateRangePreset[] | false;
  className?: string;
}

const inputClass =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 transition-all focus:border-transparent focus:ring-2 focus:ring-infinity-primary";

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
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-neutral-600">تاریخ شروع</label>
          <DatePicker
            // zaman's DatePicker is uncontrolled (`defaultValue` only, no `value` prop —
            // confirmed against the installed package's own type declarations). This field
            // has a second writer besides the picker itself (the presets below), so a `key`
            // keyed on the incoming value forces a remount whenever `start` changes
            // externally — otherwise the input would keep showing a stale date after a
            // preset click even though the report above it already refetched.
            key={toDateOnly(start)}
            defaultValue={start}
            inputClass={inputClass}
            onChange={(value: any) => onChange({ start: normalizeDateInput(value, start), end })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-neutral-600">تاریخ پایان</label>
          <DatePicker
            key={toDateOnly(end)}
            defaultValue={end}
            inputClass={inputClass}
            onChange={(value: any) => onChange({ start, end: normalizeDateInput(value, end) })}
          />
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
