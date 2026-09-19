"use client";

import OptionRadio from "./OptionRadio";

type Props = {
  title: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  ariaLabel: string;
  /** Extra `data-*` hooks the callers already expose for e2e and analytics. */
  dataProps?: Record<string, string>;
};

/**
 * The name-and-radio chip shared by every attribute that has no swatch to show:
 * sizes, models, text terms, and colour terms whose hex codes were never filled in.
 */
export default function AttributeChip({
  title,
  selected,
  disabled = false,
  onClick,
  ariaLabel,
  dataProps,
}: Props) {
  return (
    <button
      type="button"
      onClick={() => (disabled ? undefined : onClick())}
      disabled={disabled}
      aria-disabled={disabled}
      aria-pressed={selected ? "true" : "false"}
      aria-label={ariaLabel}
      title={disabled ? "ناموجود" : title}
      {...dataProps}
      className={`flex h-10 min-w-[5rem] shrink-0 items-center gap-1 rounded-xl border px-3 py-2 transition-colors ${
        disabled
          ? "pointer-events-none cursor-not-allowed border-slate-200 bg-slate-50 text-neutral-400 line-through opacity-60"
          : selected
            ? "border-infinity-primary-darker bg-white text-neutral-800"
            : "cursor-pointer border-slate-200 bg-white text-neutral-800 hover:border-infinity-primary-lighter"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-center text-sm">{title}</span>

      <OptionRadio selected={selected} />
    </button>
  );
}
