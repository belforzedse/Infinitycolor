"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { CARD, FLEX_TEXT, FOCUS_RING, ICON_BUTTON } from "./tokens";
import OverflowMenu, { type OverflowAction } from "./OverflowMenu";

/**
 * The first screenful of a resource detail page.
 *
 * Rules this encodes, applied consistently across Orders, Users and every other
 * detail screen:
 *  - a human-readable title is the visual anchor; the system ID is secondary
 *  - status is visible immediately, not buried in a form field
 *  - back navigation always exists (only 3 of 12 detail pages had one)
 *  - one primary action inline; everything rare or destructive in the overflow
 */
export default function DetailHeader({
  backHref,
  backLabel = "بازگشت",
  title,
  titleFallback = "بدون عنوان",
  identifier,
  badge,
  summary,
  primaryAction,
  actions,
  className,
}: {
  backHref?: string;
  backLabel?: string;
  /** Human-readable label. Falls back rather than showing a bare ID. */
  title?: React.ReactNode;
  titleFallback?: string;
  /** Secondary immutable identifier — typically <CopyableId />. */
  identifier?: React.ReactNode;
  badge?: React.ReactNode;
  /** Key/value pairs shown under the title (total, date, payment…). */
  summary?: { label: string; value: React.ReactNode }[];
  primaryAction?: React.ReactNode;
  actions?: OverflowAction[];
  className?: string;
}) {
  const router = useRouter();
  const hasTitle =
    title !== undefined && title !== null && title !== "" ? true : false;

  return (
    <header className={cn(CARD, "p-4 md:p-5", className)} dir="rtl">
      <div className="flex items-start gap-2">
        {/* RTL: back points left-to-right visually, i.e. ChevronLeft. */}
        {backHref ? (
          <Link
            href={backHref}
            aria-label={backLabel}
            className={cn(
              ICON_BUTTON,
              FOCUS_RING,
              "-mr-1 shrink-0 text-slate-500 hover:bg-slate-100",
            )}
          >
            <ChevronLeft className="h-5 w-5 rotate-180" aria-hidden />
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => router.back()}
            aria-label={backLabel}
            className={cn(
              ICON_BUTTON,
              FOCUS_RING,
              "-mr-1 shrink-0 text-slate-500 hover:bg-slate-100",
            )}
          >
            <ChevronLeft className="h-5 w-5 rotate-180" aria-hidden />
          </button>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1
              className={cn(
                "text-lg font-medium leading-7 md:text-xl lg:text-2xl",
                FLEX_TEXT,
                hasTitle ? "text-neutral-900" : "text-neutral-400",
              )}
            >
              {hasTitle ? title : titleFallback}
            </h1>
            {badge}
          </div>
          {identifier && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {identifier}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {primaryAction}
          {actions && actions.length > 0 && <OverflowMenu actions={actions} />}
        </div>
      </div>

      {summary && summary.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-slate-100 pt-4 sm:grid-cols-3 lg:grid-cols-4">
          {summary.map((entry) => (
            <div key={entry.label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-slate-400">{entry.label}</dt>
              <dd
                className={cn(
                  "text-sm font-medium text-slate-700",
                  FLEX_TEXT,
                )}
              >
                {entry.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </header>
  );
}
