"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "./tokens";

export type SubNavItem = {
  /** Stable key. For route-backed tabs this is usually the href. */
  id: string;
  label: string;
  /** Route-backed tab. Omit for state-backed tabs and pass `onSelect`. */
  href?: string;
  /** Optional trailing count/indicator. */
  badge?: React.ReactNode;
};

/**
 * One secondary-navigation pattern for the whole admin. Replaces five separate
 * tab implementations that each picked their own size, colour and interaction.
 *
 * Route-backed by default (pass `href`), because the app already keeps most
 * section state in the URL and that survives refresh and back-navigation.
 * State-backed usage is supported via `activeId` + `onSelect` for tabs that
 * genuinely are not routes.
 *
 * On every viewport the strip stays one horizontally scrollable row rather
 * than wrapping into a cramped grid, and every tab clears a 44px touch target.
 */
export default function SubNav({
  items,
  activeId,
  onSelect,
  className,
  ariaLabel = "بخش‌ها",
}: {
  items: SubNavItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const activeKey = activeId ?? pathname;

  // On a phone the strip scrolls sideways; opening a tab from a link (say
  // `?view=trash`) must not leave the active tab off-screen.
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>("[aria-current]");
    if (typeof active?.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeKey]);

  if (items.length === 0) return null;

  // Longest-prefix wins, so a hub landing (/sales) does not stay lit while a
  // nested tab (/sales/breakdown) is open. Plain prefix matching would mark
  // both active, which is how the old sidebar behaved.
  // State-backed tab strips pass `activeId` and never consult the route.
  const current = (pathname ?? "").replace(/\/$/, "");
  const bestMatchId = items.reduce<{ id: string; length: number } | null>(
    (best, item) => {
      if (!item.href) return best;
      const target = item.href.replace(/\/$/, "");
      const matches = current === target || current.startsWith(`${target}/`);
      if (!matches) return best;
      return !best || target.length > best.length
        ? { id: item.id, length: target.length }
        : best;
    },
    null,
  )?.id;

  const isActive = (item: SubNavItem) =>
    activeId !== undefined ? item.id === activeId : item.id === bestMatchId;

  return (
    <nav
      ref={navRef}
      aria-label={ariaLabel}
      className={cn(
        // Negative margin lets the strip bleed to the screen edge on phones so
        // the last tab does not look clipped mid-scroll. Stay on one row at
        // every breakpoint — wrapping six reserve tabs into a cramped grid is
        // how this strip used to feel broken.
        "-mx-4 overflow-x-auto overscroll-x-contain scrollbar-hide md:mx-0",
        "border-b border-slate-200",
        className,
      )}
      dir="rtl"
    >
      <ul className="flex min-w-max flex-nowrap items-stretch gap-1 px-4 md:px-0">
        {items.map((item) => {
          const active = isActive(item);
          const content = (
            <>
              <span className="whitespace-nowrap">{item.label}</span>
              {item.badge !== undefined && item.badge !== null && (
                <span
                  className={cn(
                    "text-[11px] rounded-full px-1.5 py-0.5 font-medium",
                    active
                      ? "bg-infinity-primary/10 text-infinity-primary"
                      : "bg-slate-100 text-slate-500",
                  )}
                >
                  {item.badge}
                </span>
              )}
            </>
          );

          const className = cn(
            "text-sm flex min-h-[44px] items-center gap-2 border-b-2 px-3 font-medium transition-colors md:min-h-[40px]",
            FOCUS_RING,
            active
              ? "border-infinity-primary text-infinity-primary"
              : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700",
          );

          return (
            <li key={item.id} className="flex">
              {item.href && !onSelect ? (
                <Link
                  href={item.href}
                  className={className}
                  aria-current={active ? "page" : undefined}
                >
                  {content}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect?.(item.id)}
                  className={className}
                  aria-current={active ? "true" : undefined}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
