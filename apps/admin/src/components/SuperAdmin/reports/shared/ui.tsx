"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "@/components/admin";

/**
 * A small exclusive choice (metric, perspective, scope). A radiogroup: Tab
 * enters, arrow keys move between options.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  size = "md",
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string; disabled?: boolean; hint?: string }>;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.filter((option) => !option.disabled);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const position = enabled.findIndex((option) => option.id === options[index].id);
    // In RTL the visual "next" is to the left.
    const step = event.key === "ArrowLeft" || event.key === "ArrowDown" ? 1 : -1;
    const nextPosition =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabled.length - 1
          : (position + step + enabled.length) % enabled.length;
    const next = enabled[nextPosition];
    onChange(next.id);
    refs.current[options.indexOf(next)]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-control border border-slate-200 bg-slate-50 p-0.5",
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            title={option.hint}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "whitespace-nowrap rounded-[calc(var(--radius-control)-2px)] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-xs md:text-sm",
              selected
                ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
                : "text-slate-600 hover:text-slate-900",
              FOCUS_RING,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Heading row of a workspace section: title and definition on one side, controls on the other. */
export function SectionHeader({
  title,
  description,
  actions,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h3 id={id} className="text-base font-semibold text-slate-900">
          {title}
        </h3>
        {description ? (
          <p className="max-w-3xl text-xs leading-5 text-slate-600">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
  className,
  title,
}: {
  tone?: "info" | "warning" | "error";
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
}) {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-control border px-3 py-2 text-xs leading-5",
        tone === "info" && "border-slate-200 bg-slate-50 text-slate-700",
        tone === "warning" && "border-amber-200 bg-amber-50 text-amber-900",
        tone === "error" && "border-rose-200 bg-rose-50 text-rose-900",
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** Arrow/Home/End movement for a roving-tabindex group (RTL: left is next). */
export function rovingKey(key: string, index: number, count: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowLeft") return Math.min(count - 1, index + 1);
  if (key === "ArrowRight") return Math.max(0, index - 1);
  return null;
}
