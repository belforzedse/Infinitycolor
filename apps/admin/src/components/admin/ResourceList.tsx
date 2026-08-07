"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/utils/tailwind";
import { FLEX_TEXT, FOCUS_RING } from "./tokens";

/**
 * The compact-width representation of a resource collection.
 *
 * Generalised from the Products mobile card, which was the only list in the
 * admin that got this right. The decisions worth keeping, all of which are
 * baked in here:
 *
 *  - the whole card is the primary action (not a 24px chevron)
 *  - nested controls stop propagation so they stay independently clickable
 *  - `min-w-0` / `shrink-0` / `break-words` everywhere, so long Persian names
 *    and large totals wrap instead of overflowing
 *  - values are compressed into one meta strip rather than transposing every
 *    desktop column into a label/value row
 */

export function ResourceList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col gap-2", className)} dir="rtl">
      {children}
    </ul>
  );
}

/** Wrap any control nested inside a list item so it does not trigger the row. */
export function ResourceListItemControl({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("shrink-0", className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function ResourceListItem({
  href,
  onActivate,
  media,
  title,
  titleSuffix,
  badge,
  value,
  valueCaption,
  meta,
  footer,
  selection,
  actions,
  className,
}: {
  /** Destination for whole-card activation. */
  href?: string;
  /** Alternative to `href` when activation is not a navigation. */
  onActivate?: () => void;
  /** Leading media (thumbnail, avatar, icon). */
  media?: React.ReactNode;
  /** Primary human-readable label — a person or product name, not a system ID. */
  title: React.ReactNode;
  /** Small clarifier next to the title (e.g. a secondary identifier). */
  titleSuffix?: React.ReactNode;
  /** Status indicator, rendered opposite the title. */
  badge?: React.ReactNode;
  /** High-priority value such as an order total. */
  value?: React.ReactNode;
  valueCaption?: React.ReactNode;
  /** Compact facts strip. Falsy entries are dropped. */
  meta?: React.ReactNode[];
  /** Lowest-priority metadata line (timestamps, system IDs). */
  footer?: React.ReactNode;
  selection?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
  };
  /** Trailing controls. Propagation is stopped for you. */
  actions?: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const activate = () => {
    if (onActivate) return onActivate();
    if (href) router.push(href);
  };
  const isInteractive = Boolean(href || onActivate);
  const visibleMeta = meta?.filter(Boolean) ?? [];

  return (
    <li>
      <div
        role={isInteractive ? "button" : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        onClick={isInteractive ? activate : undefined}
        onKeyDown={
          isInteractive
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  activate();
                }
              }
            : undefined
        }
        className={cn(
          "flex min-h-[76px] w-full items-start gap-3 overflow-hidden rounded-2xl border border-slate-100 bg-white p-3 shadow-sm",
          isInteractive &&
            cn("cursor-pointer hover:border-slate-200 hover:shadow-md", FOCUS_RING),
          className,
        )}
      >
        {selection && (
          <ResourceListItemControl className="pt-1">
            <label className="flex h-11 w-6 cursor-pointer items-center justify-center">
              <input
                type="checkbox"
                className="h-5 w-5 rounded border-slate-300 accent-infinity-primary"
                checked={selection.checked}
                onChange={(event) => selection.onChange(event.target.checked)}
                aria-label={selection.label ?? "انتخاب ردیف"}
              />
            </label>
          </ResourceListItemControl>
        )}

        {media && <div className="shrink-0">{media}</div>}

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex w-full min-w-0 items-start justify-between gap-2">
            <div className={cn("flex flex-col gap-0.5", FLEX_TEXT)}>
              <span className="text-sm font-medium leading-6 text-neutral-800">
                {title}
              </span>
              {titleSuffix && (
                <span className="text-xs text-neutral-500">{titleSuffix}</span>
              )}
            </div>
            {badge && <div className="shrink-0">{badge}</div>}
          </div>

          {(visibleMeta.length > 0 || value) && (
            <div className="flex w-full min-w-0 flex-col gap-2 rounded-lg bg-slate-50 px-2 py-2 sm:flex-row sm:items-center sm:justify-between">
              {visibleMeta.length > 0 && (
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                  {visibleMeta.map((entry, index) => (
                    <span
                      key={index}
                      className="text-xs flex items-center gap-1.5 text-neutral-500"
                    >
                      {index > 0 && (
                        <span className="text-neutral-300" aria-hidden>
                          |
                        </span>
                      )}
                      {entry}
                    </span>
                  ))}
                </div>
              )}

              {value && (
                <div className="flex shrink-0 flex-col text-left">
                  <span className="text-sm font-medium text-neutral-800">
                    {value}
                  </span>
                  {valueCaption && (
                    <span className="text-[11px] text-neutral-400">
                      {valueCaption}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {footer && (
            <div className="text-[11px] flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-neutral-400">
              {footer}
            </div>
          )}
        </div>

        {actions && (
          <ResourceListItemControl className="flex items-center gap-1">
            {actions}
          </ResourceListItemControl>
        )}
      </div>
    </li>
  );
}
