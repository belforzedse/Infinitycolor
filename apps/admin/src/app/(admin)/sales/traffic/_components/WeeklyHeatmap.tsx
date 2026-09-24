"use client";

import { useId, useRef, useState } from "react";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "@/components/admin";
import { numberText } from "../format";
import { HEAT_RAMP, buildWeekly, heatStep, type WeeklyCell } from "../audienceCharts";
import { SectionHeader, TableToggle, useChartTip, useEntered } from "./ui";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** «جمعه» → «جمعه‌ها» (with the zero-width non-joiner Persian plurals take). */
function plural(day: string) {
  return `${day}\u200cها`;
}

function hourSpan(hour: number) {
  return `ساعت ${numberText(hour)} تا ${numberText(hour + 1)}`;
}

/**
 * When visitors are on the site: mean sessions active in each hour of each
 * weekday, Tehran time. Hours run left to right like every time axis on the
 * page; weekdays start on Saturday.
 */
export default function WeeklyHeatmap({ value }: { value: unknown }) {
  const weekly = buildWeekly(value);
  const entered = useEntered();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tip = useChartTip(containerRef);
  const [focus, setFocus] = useState<[number, number]>([0, 0]);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const cells = useRef<Array<Array<HTMLDivElement | null>>>([]);
  if (!weekly) return null;
  const { days, max, peak } = weekly;
  const peakDay = peak ? days.find((day) => day.dow === (peak as WeeklyCell).dow) : null;

  const describe = (dayLabel: string, cell: WeeklyCell) =>
    cell.average === null
      ? `${dayLabel}، ${hourSpan(cell.hour)}: این روز در بازه نبود`
      : `${plural(dayLabel)}، ${hourSpan(cell.hour)}: میانگین ${numberText(cell.average)} نشست فعال`;

  const move = (row: number, column: number) => {
    const nextRow = Math.max(0, Math.min(days.length - 1, row));
    const nextColumn = Math.max(0, Math.min(23, column));
    cells.current[nextRow]?.[nextColumn]?.focus();
  };

  return (
    <section aria-labelledby="weekly-title" className="space-y-3">
      <SectionHeader
        id="weekly-title"
        title="ساعت‌های حضور"
        description={
          peak && peakDay
            ? `میانگین نشست‌های فعال در هر ساعت، به وقت تهران. شلوغ‌ترین زمان: ${plural(peakDay.label)}، ${hourSpan(peak.hour)}.`
            : "میانگین نشست‌های فعال در هر ساعت، به وقت تهران."
        }
        actions={
          <TableToggle showing={showTable} onToggle={() => setShowTable((shown) => !shown)} controls={tableId} />
        }
      />
      {showTable ? (
        <div id={tableId} className="overflow-x-auto rounded-control border border-slate-200">
          <table className="w-full min-w-[900px] text-[11px] tabular-nums">
            <caption className="sr-only">میانگین نشست‌های فعال در هر ساعت هر روز هفته</caption>
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">روز</th>
                {HOURS.map((hour) => (
                  <th key={hour} scope="col" className="px-1 py-1.5 text-center font-medium">
                    {numberText(hour)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.dow} className="border-t border-slate-100">
                  <th scope="row" className="whitespace-nowrap px-2 py-1.5 text-right font-medium text-slate-700">
                    {day.label}
                  </th>
                  {day.cells.map((cell) => (
                    <td key={cell.hour} className="px-1 py-1.5 text-center text-slate-800">
                      {numberText(cell.average)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={containerRef} className="relative">
          <div
            role="grid"
            aria-label="میانگین نشست‌های فعال بر اساس روز هفته و ساعت"
            className="space-y-0.5"
            onPointerLeave={tip.hide}
          >
            {days.map((day, row) => (
              <div key={day.dow} role="row" className="flex items-center gap-2">
                <div role="rowheader" className="w-16 shrink-0 text-xs text-slate-600">
                  {day.label}
                </div>
                <div dir="ltr" className="grid min-w-0 flex-1 grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5">
                  {day.cells.map((cell) => {
                    const step = heatStep(cell.average, max);
                    const label = describe(day.label, cell);
                    return (
                      <div
                        key={cell.hour}
                        ref={(node) => {
                          cells.current[row] ??= [];
                          cells.current[row][cell.hour] = node;
                        }}
                        role="gridcell"
                        aria-label={label}
                        tabIndex={focus[0] === row && focus[1] === cell.hour ? 0 : -1}
                        onPointerEnter={(event) =>
                          tip.show(
                            event.currentTarget,
                            <>
                              <p className="text-slate-600">
                                {plural(day.label)}، {hourSpan(cell.hour)}
                              </p>
                              <p className="mt-1">
                                {cell.average === null ? (
                                  "این روز در بازه نبود"
                                ) : (
                                  <span className="whitespace-nowrap">
                                    <strong className="text-sm text-slate-900">{numberText(cell.average)}</strong>{" "}
                                    نشست فعال (میانگین)
                                  </span>
                                )}
                              </p>
                            </>,
                          )
                        }
                        onFocus={(event) => {
                          setFocus([row, cell.hour]);
                          tip.show(event.currentTarget, <p>{label}</p>);
                        }}
                        onBlur={tip.hide}
                        onKeyDown={(event) => {
                          // The grid itself is LTR (time runs left to right).
                          const moves: Record<string, [number, number]> = {
                            ArrowRight: [row, cell.hour + 1],
                            ArrowLeft: [row, cell.hour - 1],
                            ArrowDown: [row + 1, cell.hour],
                            ArrowUp: [row - 1, cell.hour],
                            Home: [row, 0],
                            End: [row, 23],
                          };
                          const target = moves[event.key];
                          if (!target) return;
                          event.preventDefault();
                          move(...target);
                        }}
                        className={cn(
                          "h-6 rounded-[4px] transition-opacity duration-500 ease-out motion-reduce:transition-none",
                          step === null && "border border-dashed border-slate-200",
                          FOCUS_RING,
                        )}
                        style={{
                          background: step === null ? undefined : HEAT_RAMP[step],
                          opacity: entered ? 1 : 0,
                          transitionDelay: `${cell.hour * 12}ms`,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
            <div aria-hidden className="flex items-center gap-2 pt-1">
              <div className="w-16 shrink-0" />
              <div dir="ltr" className="grid min-w-0 flex-1 grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5 text-[10px] text-slate-500">
                {HOURS.map((hour) => (
                  <span key={hour} className="text-center">
                    {hour % 3 === 0 ? numberText(hour) : ""}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div aria-hidden className="mt-3 flex items-center justify-end gap-2 text-[11px] text-slate-500">
            <span>کم</span>
            {/* Read right to left like the labels: «کم» beside the lightest step. */}
            <span className="flex gap-0.5">
              {HEAT_RAMP.map((color) => (
                <span key={color} className="h-2.5 w-5 rounded-[3px]" style={{ background: color }} />
              ))}
            </span>
            <span>زیاد ({numberText(max)})</span>
          </div>
          {tip.tip}
        </div>
      )}
    </section>
  );
}
