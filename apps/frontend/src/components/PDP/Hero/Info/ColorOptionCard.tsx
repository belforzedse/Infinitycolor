"use client";

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A term only gets a painted swatch when it carries a usable hex; otherwise the card keeps an empty box. */
export const isValidHex = (value?: string | null): value is string =>
  typeof value === "string" && HEX_PATTERN.test(value.trim());

type Props = {
  title: string;
  colorCode?: string | null;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** Extra `data-*` hooks the callers already expose for e2e and analytics. */
  dataProps?: Record<string, string>;
  ariaLabel: string;
};

/**
 * Colour terms read better as a card — swatch on top, name underneath — than as a
 * bare dot, because a Persian colour name ("سبز زمردی") carries as much meaning as
 * the hue. Cards wrap onto extra rows instead of scrolling sideways so every term
 * stays reachable without a hidden overflow.
 */
export default function ColorOptionCard({
  title,
  colorCode,
  selected,
  disabled = false,
  onClick,
  dataProps,
  ariaLabel,
}: Props) {
  const swatch = isValidHex(colorCode) ? colorCode.trim() : null;

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
      className={[
        "flex w-20 shrink-0 flex-col overflow-hidden rounded-xl border bg-white transition-colors",
        disabled
          ? "cursor-not-allowed border-slate-200 opacity-40"
          : selected
            ? "border-infinity-primary-darker ring-1 ring-infinity-primary-darker"
            : "cursor-pointer border-slate-200 hover:border-infinity-primary-lighter",
      ].join(" ")}
    >
      <span
        className={`relative h-[50px] w-full border-b border-slate-200 ${swatch ? "" : "bg-slate-50"}`}
        style={swatch ? { backgroundColor: swatch } : undefined}
        aria-hidden="true"
      >
        {disabled && <span className="absolute inset-x-1 top-1/2 h-px rotate-[-20deg] bg-black/40" />}
      </span>

      <span className="flex h-[30px] items-center justify-center px-1.5">
        {/* Persian colour names ("سبز زمردی") outrun the card, so the label clips with an
            ellipsis while the full name stays on the button's title attribute. */}
        <span className={`w-full truncate text-center text-sm text-neutral-800 ${disabled ? "line-through" : ""}`}>
          {title}
        </span>
      </span>
    </button>
  );
}
