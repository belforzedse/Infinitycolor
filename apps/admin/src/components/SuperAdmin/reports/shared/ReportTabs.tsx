"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "@/components/admin";
import { rovingKey } from "./ui";

export type ReportTab<T extends string> = { id: T; label: string; hint?: string };

/**
 * A report page's sections as tabs: the one tab style for every report. Looks
 * like the admin's `SubNav` strip (same underline, size and touch target) so
 * it reads as part of the admin, but is an ARIA tablist: Tab enters, arrow
 * keys switch, Home/End jump. The underline slides to the chosen tab.
 */
export default function ReportTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: ReadonlyArray<ReportTab<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const selectedIndex = tabs.findIndex((tab) => tab.id === value);
  useLayoutEffect(() => {
    const node = refs.current[selectedIndex];
    if (!node) return;
    let active = true;
    const measure = () => {
      if (active) setIndicator({ left: node.offsetLeft, width: node.offsetWidth });
    };
    measure();
    // Any tab growing (a web font arriving, a label changing) moves the
    // chosen one, so watch them all, not just the chosen tab.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (observer) {
      if (listRef.current) observer.observe(listRef.current);
      refs.current.forEach((tab) => tab && observer.observe(tab));
    }
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [selectedIndex, tabs]);
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className="relative -mx-4 flex gap-1 overflow-x-auto overscroll-x-contain border-b border-slate-200 px-4 scrollbar-hide md:mx-0 md:px-0"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            id={`${idPrefix}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            title={tab.hint}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const next = rovingKey(event.key, index, tabs.length);
              if (next === null) return;
              event.preventDefault();
              onChange(tabs[next].id);
              refs.current[next]?.focus();
            }}
            className={cn(
              "-mb-px flex min-h-[44px] shrink-0 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors md:min-h-[40px]",
              FOCUS_RING,
              selected
                ? cn("text-infinity-primary", indicator ? "border-transparent" : "border-infinity-primary")
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700",
            )}
          >
            {tab.label}
          </button>
        );
      })}
      {indicator ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-infinity-primary transition-[left,width] duration-300 ease-out motion-reduce:transition-none"
          style={{ left: indicator.left, width: indicator.width }}
        />
      ) : null}
    </div>
  );
}
