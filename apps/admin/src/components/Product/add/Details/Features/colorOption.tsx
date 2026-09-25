import type { VariationOption } from "@/services/product/variation-options";

/**
 * Colour row for the search dropdown.
 *
 * Colours imported without a ColorCode all rendered as the same anonymous grey
 * dot, so a list of them read as one option repeated. Mark those as deliberately
 * colourless instead.
 */
export function renderColorOption(
  option: VariationOption,
  isSelected: boolean,
  selectedLabel = "افزوده شده",
) {
  return (
    <>
      {option.colorCode ? (
        <span
          className="h-5 w-5 shrink-0 rounded-full border border-slate-200"
          style={{ backgroundColor: option.colorCode }}
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-slate-300 bg-white text-[10px] text-slate-400"
        >
          —
        </span>
      )}
      <span className="min-w-0 truncate">{option.title}</span>
      {option.colorCode ? (
        <span className="shrink-0 text-xs text-slate-400" dir="ltr">
          {option.colorCode.toUpperCase()}
        </span>
      ) : (
        <span className="shrink-0 text-xs text-slate-400">بدون رنگ</span>
      )}
      {isSelected && (
        <span className="text-[11px] text-green-600">{selectedLabel}</span>
      )}
    </>
  );
}
