import type { DataQualityWarning } from "@/services/super-admin/reports/products/types";

/**
 * The caveat strip under a report. Previously duplicated verbatim in OverviewTab
 * and PaymentShippingTab; extracted so data-quality warnings render consistently
 * everywhere rather than being bolted onto one tab.
 *
 * Warnings are visually distinct from notes on purpose: a note explains how a
 * figure is derived, a warning says the figure is *wrong*.
 */
export default function ReportNotes({
  note,
  warnings,
}: {
  note?: string;
  warnings?: DataQualityWarning[];
}) {
  const hasWarnings = Boolean(warnings && warnings.length > 0);
  if (!note && !hasWarnings) return null;

  return (
    <div className="space-y-2">
      {hasWarnings && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-6 text-red-800"
        >
          <p className="font-semibold">هشدار صحت داده</p>
          <ul className="mt-1 list-inside list-disc space-y-1">
            {warnings!.map((warning) => (
              <li key={`${warning.code}:${warning.gateway}`}>{warning.message}</li>
            ))}
          </ul>
        </div>
      )}
      {note && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-6 text-amber-700">
          {note}
        </p>
      )}
    </div>
  );
}
