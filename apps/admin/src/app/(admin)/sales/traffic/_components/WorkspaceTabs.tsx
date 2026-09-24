"use client";

import { useRef } from "react";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "@/components/admin";
import { rovingKey } from "./ui";

export type WorkspaceTab<T extends string> = { id: T; label: string; hint?: string };

/**
 * The workspace's sections as tabs. Looks like the admin's `SubNav` strip
 * (same underline, size and touch target) so it reads as part of the admin,
 * but is an ARIA tablist: Tab enters, arrow keys switch, Home/End jump.
 */
export default function WorkspaceTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: ReadonlyArray<WorkspaceTab<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div
      role="tablist"
      aria-label={label}
      className="-mx-4 flex gap-1 overflow-x-auto overscroll-x-contain border-b border-slate-200 px-4 scrollbar-hide md:mx-0 md:px-0"
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
                ? "border-infinity-primary text-infinity-primary"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
