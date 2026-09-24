"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "@/components/admin";
import { faNum } from "@/utils/faNum";

export type AnalyticsColumn<Row> = {
  key: string;
  label: ReactNode;
  /** Numbers align to the end of the cell and sort descending first. */
  numeric?: boolean;
  render: (row: Row, index: number) => ReactNode;
  sortValue?: (row: Row) => number | string | null;
  /** Shown under the header for columns whose definition is not obvious. */
  hint?: string;
  className?: string;
};

const DEFAULT_VISIBLE = 30;
const STICKY_AFTER = 15;

/**
 * The workspace's one table. Numeric columns align and use tabular figures,
 * sorting is stable (ties keep the provider's order), long tables get a sticky
 * header inside their own scroll area, and narrow screens scroll the table
 * horizontally instead of squeezing the label column.
 */
export function AnalyticsTable<Row>({
  caption,
  rows,
  columns,
  rowKey,
  defaultSort,
  maxRows = DEFAULT_VISIBLE,
  emptyText = "برای این بازه داده‌ای ثبت نشده است",
  minWidth = 560,
  dense = false,
  rowClassName,
}: {
  caption: string;
  rows: Row[];
  columns: AnalyticsColumn<Row>[];
  rowKey: (row: Row, index: number) => string;
  defaultSort?: { key: string; direction: "asc" | "desc" };
  maxRows?: number;
  emptyText?: string;
  minWidth?: number;
  dense?: boolean;
  rowClassName?: (row: Row) => string | undefined;
}) {
  const [sort, setSort] = useState(defaultSort ?? null);
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(() => {
    const column = sort ? columns.find((candidate) => candidate.key === sort.key) : null;
    if (!sort || !column?.sortValue) return rows;
    const direction = sort.direction === "asc" ? 1 : -1;
    return rows
      .map((row, index) => ({ row, index, value: column.sortValue!(row) }))
      .sort((left, right) => {
        // Missing values always sink, whichever the direction.
        if (left.value === null && right.value === null) return left.index - right.index;
        if (left.value === null) return 1;
        if (right.value === null) return -1;
        const compared =
          typeof left.value === "number" && typeof right.value === "number"
            ? left.value - right.value
            : String(left.value).localeCompare(String(right.value), "fa");
        return compared ? compared * direction : left.index - right.index;
      })
      .map((entry) => entry.row);
  }, [columns, rows, sort]);

  if (!rows.length) {
    return (
      <p className="rounded-control border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-500">
        {emptyText}
      </p>
    );
  }

  const visible = expanded ? sorted : sorted.slice(0, maxRows);
  const sticky = visible.length > STICKY_AFTER;

  const toggleSort = (column: AnalyticsColumn<Row>) => {
    if (!column.sortValue) return;
    setSort((current) =>
      current?.key === column.key
        ? { key: column.key, direction: current.direction === "desc" ? "asc" : "desc" }
        : { key: column.key, direction: column.numeric ? "desc" : "asc" },
    );
  };

  return (
    <div>
      <div
        className={cn(
          "overflow-x-auto rounded-control border border-slate-100",
          sticky && "max-h-[560px] overflow-y-auto",
        )}
      >
        <table className="w-full border-collapse text-right text-xs" style={{ minWidth }}>
          <caption className="sr-only">{caption}</caption>
          <thead className={cn("bg-slate-50 text-slate-600", sticky && "sticky top-0 z-10")}>
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key;
                const Icon = active && sort?.direction === "asc" ? ChevronUp : ChevronDown;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      active ? (sort?.direction === "asc" ? "ascending" : "descending") : undefined
                    }
                    className={cn(
                      "whitespace-nowrap border-b border-slate-100 px-3 py-2.5 font-medium",
                      column.numeric ? "text-left" : "text-right",
                      column.className,
                    )}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded hover:text-slate-900",
                          FOCUS_RING,
                        )}
                      >
                        {column.label}
                        <Icon
                          aria-hidden
                          className={cn("size-3.5", active ? "opacity-100" : "opacity-30")}
                        />
                      </button>
                    ) : (
                      column.label
                    )}
                    {column.hint ? (
                      <span className="block text-[10px] font-normal text-slate-500">
                        {column.hint}
                      </span>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-800">
            {visible.map((row, index) => (
              <tr key={rowKey(row, index)} className={cn("hover:bg-slate-50/70", rowClassName?.(row))}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "px-3 align-middle",
                      dense ? "py-1.5" : "py-2.5",
                      column.numeric ? "whitespace-nowrap text-left tabular-nums" : "text-right",
                      column.className,
                    )}
                  >
                    {column.render(row, index)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > maxRows ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            "mt-2 rounded text-xs font-medium text-infinity-primary hover:underline",
            FOCUS_RING,
          )}
        >
          {expanded
            ? `نمایش ${faNum(maxRows)} ردیف برتر`
            : `نمایش همه ${faNum(sorted.length)} ردیف`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A label cell for machine values such as URLs and campaign names: visually
 * truncated at the cell width, with the full value in `title` and for screen
 * readers, and a raw value (when it differs) underneath in LTR.
 */
export function LabelCell({
  label,
  raw,
  icon,
  maxWidth = 320,
}: {
  label: string;
  raw?: string | null;
  icon?: ReactNode;
  maxWidth?: number;
}) {
  const showRaw = raw && raw.trim() && raw.trim() !== label;
  return (
    <span className="flex min-w-0 items-center gap-2" style={{ maxWidth }}>
      {icon}
      <span className="min-w-0">
        <span className="block truncate font-medium text-slate-800" title={showRaw ? `${label} — ${raw}` : label}>
          {label}
        </span>
        {showRaw ? (
          <span className="block truncate text-[11px] text-slate-500" dir="ltr" title={raw ?? undefined}>
            {raw}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** A proportion bar behind a number, for scanning shares inside a table. */
export function ShareBar({ share, children }: { share: number | null; children: ReactNode }) {
  const width = share === null ? 0 : Math.max(0, Math.min(100, share * 100));
  return (
    <span className="inline-flex min-w-[96px] items-center justify-end gap-2">
      <span aria-hidden className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-100">
        <span className="block h-full rounded-full bg-infinity-primary/60" style={{ width: `${width}%` }} />
      </span>
      <span>{children}</span>
    </span>
  );
}
