"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDebounce } from "use-debounce";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";
import type { VariationOption } from "@/services/product/variation-options";

type PickerStatus = "idle" | "loading" | "success" | "error";

type AsyncSearchPickerProps = {
  placeholder: string;
  /** Runs the server query. Keep its identity stable — it is an effect dependency. */
  search: (query: string) => Promise<VariationOption[]>;
  /** Already-chosen ids, rendered as «افزوده شده» and not selectable again. */
  selectedIds: ReadonlySet<string>;
  onPick: (option: VariationOption) => void | Promise<void>;
  renderOption?: (option: VariationOption, isSelected: boolean) => ReactNode;
  /** Omit to hide the "create this one" affordance entirely. */
  onCreate?: (query: string) => void | Promise<void>;
  createLabel?: (query: string) => string;
  createDisabled?: boolean;
  disabled?: boolean;
  minChars?: number;
  debounceMs?: number;
};

/**
 * A combobox that queries the server as you type.
 *
 * Replaces the fetch-everything-then-filter-locally pickers that could only ever
 * see the first 100 rows the backend would return (`rest.maxLimit`).
 *
 * Races are handled with a sequence token rather than an `AbortSignal`: apiClient
 * dedupes concurrent GETs by cache key and hands both callers the same promise,
 * so aborting one would reject an unrelated caller's request too.
 */
export default function AsyncSearchPicker({
  placeholder,
  search,
  selectedIds,
  onPick,
  renderOption,
  onCreate,
  createLabel,
  createDisabled = false,
  disabled = false,
  minChars = 1,
  debounceMs = 250,
}: AsyncSearchPickerProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebounce(query, debounceMs);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);

  /**
   * Results stay tagged with the query that produced them.
   *
   * Keeping the tag means a stale result set can simply be ignored at render
   * time, so the effect never has to synchronously reset state to clear it —
   * which would cost an extra render pass on every keystroke.
   */
  const [result, setResult] = useState<{
    query: string;
    status: Exclude<PickerStatus, "idle" | "loading">;
    options: VariationOption[];
  } | null>(null);

  useDismissOnOutside(containerRef, isOpen, () => setIsOpen(false));

  const trimmedQuery = query.trim();
  const debouncedTrimmed = debouncedQuery.trim();
  const isSearchable = trimmedQuery.length >= minChars;

  useEffect(() => {
    if (debouncedTrimmed.length < minChars) {
      // Bump the token so a slower in-flight request cannot land after this.
      seqRef.current += 1;
      return;
    }

    const seq = ++seqRef.current;
    void search(debouncedTrimmed)
      .then((options) => {
        if (seq !== seqRef.current) return;
        setResult({ query: debouncedTrimmed, status: "success", options });
      })
      .catch((error) => {
        if (seq !== seqRef.current) return;
        console.error("Option search failed:", error);
        setResult({ query: debouncedTrimmed, status: "error", options: [] });
      });
  }, [debouncedTrimmed, minChars, search]);

  // Anything not matching the text currently in the box is stale by definition.
  const current = result && result.query === trimmedQuery ? result : null;
  const status: PickerStatus = !isSearchable
    ? "idle"
    : (current?.status ?? "loading");
  const options = current?.options ?? [];

  /** Clears the box and discards any in-flight response for the old query. */
  const reset = () => {
    seqRef.current += 1;
    setQuery("");
    setResult(null);
    setIsOpen(false);
  };

  const handlePick = async (option: VariationOption) => {
    if (selectedIds.has(option.id)) return;
    await onPick(option);
    reset();
  };

  /**
   * Resets after creating too, not just after picking. Otherwise the box still
   * holds the name that was just created and keeps offering to create it again —
   * and the second attempt fails on the unique constraint.
   */
  const handleCreate = async () => {
    await onCreate?.(trimmedQuery);
    reset();
  };
  // Only offer "create" once a search has actually resolved, so the button never
  // appears for a name the server was about to return.
  const canOfferCreate =
    Boolean(onCreate) &&
    trimmedQuery.length > 0 &&
    (status === "success" || status === "error") &&
    !options.some((option) => option.title.trim() === trimmedQuery);

  return (
    <div className="relative min-w-[140px] flex-1" ref={containerRef}>
      <input
        type="text"
        className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-400"
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
      />

      {isOpen && trimmedQuery.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {status === "loading" && (
            <div className="px-3 py-2 text-xs text-neutral-500">در حال جستجو...</div>
          )}

          {status === "error" && (
            <div className="px-3 py-2 text-xs text-red-600">جستجو انجام نشد</div>
          )}

          {status === "success" && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">موردی یافت نشد</div>
          )}

          {status === "success" &&
            options.map((option) => {
              const isSelected = selectedIds.has(option.id);
              return (
                <button
                  type="button"
                  key={option.id}
                  onClick={() => void handlePick(option)}
                  aria-disabled={isSelected}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-right text-sm ${
                    isSelected
                      ? "cursor-not-allowed text-slate-400"
                      : "cursor-pointer hover:bg-slate-100"
                  }`}
                >
                  {renderOption ? (
                    renderOption(option, isSelected)
                  ) : (
                    <>
                      <span className="min-w-0 truncate">{option.title}</span>
                      {isSelected && (
                        <span className="text-[11px] text-green-600">افزوده شده</span>
                      )}
                    </>
                  )}
                </button>
              );
            })}

          {canOfferCreate && (
            <button
              type="button"
              disabled={createDisabled}
              onClick={() => void handleCreate()}
              className={`flex w-full items-center justify-between border-t border-slate-100 px-3 py-2 text-xs ${
                createDisabled
                  ? "cursor-not-allowed text-slate-400"
                  : "text-blue-600 hover:bg-blue-50"
              }`}
            >
              <span>
                {createLabel ? createLabel(trimmedQuery) : `افزودن «${trimmedQuery}»`}
              </span>
              <span aria-hidden="true">+</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
