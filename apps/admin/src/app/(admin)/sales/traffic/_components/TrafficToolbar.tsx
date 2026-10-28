"use client";

import { useState, type ReactNode } from "react";
import { RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { AdminCard, FOCUS_RING } from "@/components/admin";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import {
  parseDateOnly,
  toDateOnly,
} from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import type { BehaviorFilters } from "@/types/super-admin/reports/behavior";
import { validateBehaviorQuery } from "@/services/super-admin/reports/behavior";
import { cn } from "@/utils/tailwind";
import { faNum } from "@/utils/faNum";
import { dateTimeText } from "@/components/SuperAdmin/reports/shared/format";
import {
  activeFilterKeys,
  BROWSER_OPTIONS,
  DEVICE_OPTIONS,
  FILTER_LABELS,
  filterScopeText,
  OS_OPTIONS,
  SECONDARY_FILTER_GROUPS,
} from "../filters";
import { FILTERABLE_EVENTS, presentBehaviorValue, REGION_OPTIONS } from "../presentation";

const CONTROL =
  "h-9 w-full rounded-control border border-slate-200 bg-white px-2.5 text-sm text-slate-800 hover:border-slate-300 focus:border-infinity-primary";

function SelectFilter({
  name,
  value,
  options,
  onChange,
}: {
  name: keyof BehaviorFilters;
  value: string | undefined;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string | undefined) => void;
}) {
  // A value set elsewhere (a shared link, «more filters») stays selectable.
  const list = value && !options.some((option) => option.value === value)
    ? [...options, { value, label: value }]
    : options;
  return (
    <label className="min-w-0 space-y-1 text-xs text-slate-700">
      <span className="block font-medium">{FILTER_LABELS[name]}</span>
      <select
        aria-label={FILTER_LABELS[name]}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        className={cn(CONTROL, FOCUS_RING)}
      >
        <option value="">همه</option>
        {list.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SecondaryField({
  name,
  draft,
  setDraft,
  error,
}: {
  name: keyof BehaviorFilters;
  draft: BehaviorFilters;
  setDraft: (update: (current: BehaviorFilters) => BehaviorFilters) => void;
  error?: string;
}) {
  const update = (value: string) =>
    setDraft((current) => ({ ...current, [name]: value || undefined }));
  const common = cn(CONTROL, FOCUS_RING);
  let control: ReactNode;
  if (name === "match" || name === "excludeBounce" || name === "event") {
    const options =
      name === "match"
        ? [
            { value: "all", label: "همه شرط‌ها" },
            { value: "any", label: "حداقل یک شرط" },
          ]
        : name === "excludeBounce"
          ? [
              { value: "true", label: "بله" },
              { value: "false", label: "خیر" },
            ]
          : FILTERABLE_EVENTS;
    control = (
      <select
        aria-label={FILTER_LABELS[name]}
        value={draft[name] ?? ""}
        onChange={(event) => update(event.target.value)}
        className={common}
      >
        <option value="">{name === "event" ? "همه اقدام‌ها" : "پیش‌فرض"}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        aria-label={FILTER_LABELS[name]}
        value={String(draft[name] ?? "")}
        onChange={(event) => update(event.target.value)}
        placeholder={
          name === "path"
            ? "مثلاً /plp یا /pdp/نام-محصول"
            : name === "segment" || name === "cohort"
              ? "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              : ""
        }
        dir="ltr"
        className={cn(common, "text-left")}
      />
    );
  }
  return (
    <label className="min-w-0 space-y-1 text-xs text-slate-700">
      <span className="block font-medium">{FILTER_LABELS[name]}</span>
      {control}
      {error ? <span className="block text-rose-700">{error}</span> : null}
    </label>
  );
}

function filterValueText(key: keyof BehaviorFilters, value: string): string {
  if (key === "device") return presentBehaviorValue(value, "device");
  if (key === "browser") return presentBehaviorValue(value, "browser");
  if (key === "os") return presentBehaviorValue(value, "os");
  if (key === "region") return presentBehaviorValue(value, "region");
  if (key === "country") return presentBehaviorValue(value, "country");
  if (key === "event") return presentBehaviorValue(value, "event");
  if (key === "excludeBounce") return value === "true" ? "بله" : "خیر";
  if (key === "match") return value === "any" ? "حداقل یک شرط" : "همه شرط‌ها";
  return value;
}

/**
 * Period, comparison, filters, refresh and live status: the one control row
 * that scopes everything below it. Each filter says where it applies.
 */
export default function TrafficToolbar({
  start,
  end,
  onRange,
  compare,
  onCompare,
  filters,
  onFilters,
  onRefresh,
  refreshing,
  refreshedAt,
  realtime,
}: {
  start: string;
  end: string;
  onRange: (range: { start: string; end: string }) => void;
  compare: boolean;
  onCompare: (enabled: boolean) => void;
  filters: BehaviorFilters;
  onFilters: (filters: BehaviorFilters) => void;
  onRefresh: () => void;
  refreshing: boolean;
  refreshedAt?: string | null;
  realtime: ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [draft, setDraft] = useState<BehaviorFilters>(filters);
  const [syncedFilters, setSyncedFilters] = useState(filters);
  if (syncedFilters !== filters) {
    // A filter changed from outside (a token removed, the URL edited): restart the draft.
    setSyncedFilters(filters);
    setDraft(filters);
  }
  const active = activeFilterKeys(filters);
  const validation = validateBehaviorQuery({ start: "2026-01-01", end: "2026-01-01", filters: draft });
  const setPrimary = (key: keyof BehaviorFilters, value: string | undefined) =>
    onFilters(clean({ ...filters, [key]: value }));
  const secondaryCount = active.filter(
    (key) => !["device", "os", "browser", "region"].includes(key),
  ).length;

  return (
    <AdminCard padded={false}>
      <div className="flex flex-col gap-4 p-4 md:p-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-sm font-medium text-slate-800">بازه گزارش</p>
          <ReportDateRangeField
            start={parseDateOnly(start)}
            end={parseDateOnly(end)}
            onChange={(range) =>
              onRange({ start: toDateOnly(range.start), end: toDateOnly(range.end) })
            }
          />
          <p className="mt-2 text-xs text-slate-600">
            همه تاریخ‌ها و ساعت‌ها به وقت تهران. آخرین بروزرسانی: {dateTimeText(refreshedAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label
            className={cn(
              "flex h-9 cursor-pointer items-center gap-2 rounded-control border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700",
              "focus-within:ring-2 focus-within:ring-infinity-primary",
            )}
          >
            <input
              type="checkbox"
              checked={compare}
              onChange={(event) => onCompare(event.target.checked)}
              className="size-4 accent-infinity-primary"
            />
            مقایسه با دوره قبل
          </label>
          {realtime}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-control bg-infinity-primary px-3 text-xs font-medium text-white hover:bg-infinity-primary-dark disabled:opacity-60",
              FOCUS_RING,
            )}
          >
            <RefreshCw aria-hidden className={cn("size-3.5", refreshing && "animate-spin")} />
            {refreshing ? "در حال بارگذاری…" : "بروزرسانی"}
          </button>
        </div>
      </div>

      <div className="border-t border-slate-100 p-4 md:px-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto] xl:items-end">
          <SelectFilter name="device" value={filters.device} options={DEVICE_OPTIONS} onChange={(value) => setPrimary("device", value)} />
          <SelectFilter name="os" value={filters.os} options={OS_OPTIONS} onChange={(value) => setPrimary("os", value)} />
          <SelectFilter name="browser" value={filters.browser} options={BROWSER_OPTIONS} onChange={(value) => setPrimary("browser", value)} />
          <SelectFilter name="region" value={filters.region} options={REGION_OPTIONS} onChange={(value) => setPrimary("region", value)} />
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-controls="traffic-more-filters"
            onClick={() => setMoreOpen((value) => !value)}
            className={cn(
              "col-span-2 inline-flex h-9 items-center justify-center gap-2 rounded-control border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-300 md:col-span-4 xl:col-span-1",
              FOCUS_RING,
            )}
          >
            <SlidersHorizontal aria-hidden className="size-3.5" />
            فیلترهای بیشتر
            {secondaryCount ? <span className="tabular-nums">({faNum(secondaryCount)})</span> : null}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-600">
          دستگاه، سیستم‌عامل، مرورگر و استان روی همه بخش‌ها، از جمله قیف، اعمال می‌شوند. سفارش‌ها و
          درآمد فیلتر نمی‌شوند.
        </p>

        {active.length ? (
          <ul className="mt-3 flex flex-wrap gap-2" aria-label="فیلترهای فعال">
            {active.map((key) => (
              <li
                key={key}
                className="inline-flex max-w-full items-center gap-1.5 rounded-control border border-slate-200 bg-slate-50 py-1 pe-1 ps-2 text-xs text-slate-800"
              >
                <span className="min-w-0 truncate">
                  {FILTER_LABELS[key]}: <strong className="font-medium">{filterValueText(key, String(filters[key]))}</strong>
                  <span className="text-slate-500"> · {filterScopeText(key)}</span>
                </span>
                <button
                  type="button"
                  aria-label={`حذف فیلتر ${FILTER_LABELS[key]}`}
                  onClick={() => onFilters(clean({ ...filters, [key]: undefined }))}
                  className={cn("grid size-5 place-items-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-900", FOCUS_RING)}
                >
                  <X aria-hidden className="size-3" />
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => onFilters({})}
                className={cn("rounded px-1 py-1 text-xs font-medium text-infinity-primary hover:underline", FOCUS_RING)}
              >
                پاک کردن همه
              </button>
            </li>
          </ul>
        ) : null}

        {moreOpen ? (
          <div id="traffic-more-filters" className="mt-4 space-y-5 border-t border-slate-100 pt-4">
            {SECONDARY_FILTER_GROUPS.map((group) => (
              <fieldset key={group.title} className="space-y-2">
                <legend className="text-xs font-semibold text-slate-900">{group.title}</legend>
                <p className="text-[11px] text-slate-600">{group.note}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {group.keys.map((key) => (
                    <SecondaryField
                      key={key}
                      name={key}
                      draft={draft}
                      setDraft={setDraft}
                      error={validation.errors[key]}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!validation.ok}
                onClick={() => onFilters(clean(draft))}
                className={cn(
                  "h-9 rounded-control bg-infinity-primary px-4 text-xs font-medium text-white disabled:opacity-50",
                  FOCUS_RING,
                )}
              >
                اعمال فیلترها
              </button>
              <button
                type="button"
                onClick={() => setDraft(filters)}
                className={cn("h-9 rounded-control border border-slate-200 px-4 text-xs text-slate-700", FOCUS_RING)}
              >
                بازگرداندن
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </AdminCard>
  );
}

function clean(filters: BehaviorFilters): BehaviorFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => typeof value === "string" && value.trim()),
  ) as BehaviorFilters;
}
