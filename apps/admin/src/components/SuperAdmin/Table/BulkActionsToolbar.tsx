"use client";

import SuperAdminTableSelect from "./Select";
import type { BulkActionOption } from "./bulkActions";

type BulkActionsToolbarProps = {
  options: BulkActionOption[];
  selectedCount: number;
  allSelected: boolean;
  onToggleAll: (checked: boolean) => void;
  selectedActionId: string;
  onSelectAction: (id: string) => void;
  onExecute: () => void;
  busy: boolean;
  /** Mobile layout: the select flexes, the button does not shrink. */
  compact?: boolean;
};

/**
 * The «اقدام دسته جمعی» controls.
 *
 * Extracted because this markup existed twice — once in the mobile card header
 * and once as a `<tr>` inside `<thead>` — with character-identical execute
 * handlers, so any fix had to be made in two places or silently applied to only
 * one layout. The two callers still own their own layout wrappers; only the
 * controls live here.
 */
export default function BulkActionsToolbar({
  options,
  selectedCount,
  allSelected,
  onToggleAll,
  selectedActionId,
  onSelectAction,
  onExecute,
  busy,
  compact = false,
}: BulkActionsToolbarProps) {
  const nothingSelected = selectedCount === 0;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={(event) => onToggleAll(event.target.checked)}
          aria-label="انتخاب همه"
        />
        <span className="text-foreground-primary text-xs">انتخاب همه</span>
        {/* The count was absent entirely, so a bulk action gave no indication of
            how many rows it was about to touch. */}
        {selectedCount > 0 && (
          <span
            className="text-xs text-neutral-500"
            data-testid="bulk-selected-count"
          >
            ({selectedCount} مورد انتخاب شده)
          </span>
        )}
      </div>

      <div
        className={
          compact
            ? "flex min-w-0 flex-1 items-center justify-end gap-2"
            : "flex items-center gap-2"
        }
      >
        <SuperAdminTableSelect
          className={compact ? "min-w-0 max-w-full flex-1 sm:flex-none" : undefined}
          selectedOption={selectedActionId}
          onOptionSelect={(id) => onSelectAction(String(id))}
          options={[{ id: "", title: "اقدام دسته جمعی" }, ...options]}
        />

        <button
          type="button"
          onClick={onExecute}
          // Previously always enabled: with nothing selected it still fired the
          // handler with an empty array, and a double-click ran the batch twice.
          disabled={busy || nothingSelected || !selectedActionId}
          title={nothingSelected ? "ابتدا ردیف‌ها را انتخاب کنید" : undefined}
          className="flex shrink-0 items-center justify-between rounded-lg bg-actions-primary px-3 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="bulk-action-execute"
        >
          {busy ? "در حال انجام..." : "اجرا"}
        </button>
      </div>
    </>
  );
}
