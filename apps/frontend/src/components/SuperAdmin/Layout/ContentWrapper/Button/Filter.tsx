import SuperAdminTableSelect from "@/components/SuperAdmin/Table/Select";
import FilterIcon from "../../Icons/FilterIcon";
import FilterCloseIcon from "../../Icons/FilterCloseIcon";
import TrashIcon from "../../Icons/TrashIcon";
import WhitePlusIcon from "../../Icons/WhitePlusIcon";
import { Input } from "@/components/ui/Input";
import { useQueryState } from "nuqs";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  NULL_OPERATORS,
  OPERATOR_LABELS,
  describeAdvancedFilter,
  operatorsForField,
  parseAdvancedFiltersParam,
  sanitizeAdvancedFilters,
  serializeAdvancedFiltersParam,
  type AdvancedFilterField,
  type AdvancedFilterItem,
} from "@/components/SuperAdmin/Table/advancedFilters";

type Props = {
  isFilterOpen: boolean;
  options: AdvancedFilterField[];
  setFilterIsOpen: (isFilterOpen: boolean) => void;
};

const EMPTY_FILTER: AdvancedFilterItem = {
  value: "",
  field: "",
  operator: "",
};

function defaultOptionsForField(field?: AdvancedFilterField) {
  if (!field) return [];
  if (field.options?.length) return field.options;
  if (field.type === "boolean") {
    return [
      { id: "true", title: "بله" },
      { id: "false", title: "خیر" },
    ];
  }
  return [];
}

export default function SuperAdminLayoutContentWrapperButtonFilter({
  isFilterOpen,
  setFilterIsOpen,
  options,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);

  const [filter, setFilter] = useQueryState<AdvancedFilterItem[]>("filter", {
    defaultValue: [],
    parse: parseAdvancedFiltersParam,
    serialize: serializeAdvancedFiltersParam,
  });
  const [, setPage] = useQueryState("page", { defaultValue: "1" });
  const [draft, setDraft] = useState<AdvancedFilterItem[]>(filter);

  const validDraft = useMemo(() => sanitizeAdvancedFilters(draft, options), [draft, options]);
  const draftHasInvalidRows = draft.length !== validDraft.length;
  const activeFilters = useMemo(
    () =>
      sanitizeAdvancedFilters(filter, options)
        .map((item) => ({ item, label: describeAdvancedFilter(item, options) }))
        .filter((entry): entry is { item: AdvancedFilterItem; label: string } =>
          Boolean(entry.label),
        ),
    [filter, options],
  );

  useEffect(() => {
    if (isFilterOpen) {
      setDraft(filter);
      requestAnimationFrame(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = dialog.querySelector<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
        (focusable ?? dialog).focus();
      });
    } else if (wasOpenRef.current) {
      triggerRef.current?.focus();
    }

    wasOpenRef.current = isFilterOpen;
  }, [filter, isFilterOpen]);

  const updateDraftItem = (index: number, patch: Partial<AdvancedFilterItem>) => {
    setDraft((prev) =>
      prev.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const next = { ...item, ...patch };
        const nextField = options.find((field) => field.id === next.field);
        const allowedOperators = operatorsForField(nextField);

        if (patch.field) {
          next.operator = allowedOperators[0] ?? "";
          next.value = "";
        }

        if (patch.operator && NULL_OPERATORS.has(patch.operator)) {
          next.value = "";
        }

        return next;
      }),
    );
  };

  const applyFilters = async () => {
    if (draftHasInvalidRows) return;
    await setFilter(validDraft);
    await setPage("1");
    setFilterIsOpen(false);
  };

  const clearFilters = async () => {
    setDraft([]);
    await setFilter([]);
    await setPage("1");
    setFilterIsOpen(false);
  };

  return (
    <div className="relative w-full md:w-auto">
      <button
        ref={triggerRef}
        type="button"
        className="flex w-full items-center justify-center gap-1 rounded-lg border border-slate-400 bg-white px-3 py-1 text-sm text-slate-700 md:w-auto"
        onClick={() => {
          setFilterIsOpen(!isFilterOpen);
        }}
        aria-haspopup="dialog"
        aria-expanded={isFilterOpen}
        disabled={options.length === 0}
        title={options.length === 0 ? "فیلتری برای این صفحه تعریف نشده است" : undefined}
      >
        <FilterIcon />
        <span className="text-foreground-primary">فیلتر پیشرفته</span>
        {activeFilters.length > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-actions-primary px-1.5 text-[11px] text-white">
            {activeFilters.length}
          </span>
        )}
      </button>

      {activeFilters.length > 0 && (
        <div className="mt-2 flex max-w-full flex-wrap gap-1.5">
          {activeFilters.map(({ item, label }) => (
            <button
              key={`${item.field}-${item.operator}-${item.value}`}
              type="button"
              className="flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700"
              onClick={async () => {
                const next = filter.filter((candidate) => candidate !== item);
                await setFilter(next);
                await setPage("1");
              }}
              title="حذف فیلتر"
            >
              <span className="truncate">{label}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      {isFilterOpen && (
        <div
          ref={dialogRef}
          className="fixed left-4 right-4 top-28 z-[1200] flex max-h-[calc(100dvh-8rem)] cursor-auto flex-col gap-3 overflow-y-auto rounded-2xl border border-slate-100 bg-white p-3 shadow-lg md:absolute md:left-0 md:right-auto md:top-full md:z-10 md:mt-2 md:max-h-none md:w-[420px] md:max-w-[calc(100vw-2rem)] md:overflow-visible md:rounded-lg"
          role="dialog"
          aria-label="فیلتر پیشرفته"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFilterIsOpen(false);
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-slate-800">فیلتر پیشرفته</span>
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-50"
              onClick={() => setFilterIsOpen(false)}
              aria-label="بستن فیلتر"
            >
              <FilterCloseIcon />
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {draft.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500">
                هنوز فیلتری اضافه نشده است.
              </div>
            )}

            {draft.map((item, index) => {
              const selectedField = options.find((field) => field.id === item.field);
              const operators = operatorsForField(selectedField).map((operator) => ({
                id: operator,
                title: OPERATOR_LABELS[operator] ?? operator,
              }));
              const valueOptions = defaultOptionsForField(selectedField);
              const isNullOperator = NULL_OPERATORS.has(item.operator);

              return (
                <div
                  key={index}
                  className="grid grid-cols-1 gap-1.5 rounded-xl border border-slate-100 bg-slate-50/60 p-2 sm:grid-cols-[1fr_1fr_1.1fr_auto] sm:items-center"
                >
                  <SuperAdminTableSelect
                    buttonClassName="!p-1.5"
                    iconClassName="!h-5 !w-5"
                    selectedOption={item.field}
                    options={[{ id: "", title: "فیلد" }, ...options]}
                    onOptionSelect={(id) => {
                      updateDraftItem(index, { field: id.toString() });
                    }}
                  />

                  <SuperAdminTableSelect
                    buttonClassName="!p-1.5"
                    iconClassName="!h-5 !w-5"
                    selectedOption={item.operator}
                    options={[{ id: "", title: "عملگر" }, ...operators]}
                    onOptionSelect={(id) => {
                      updateDraftItem(index, { operator: id.toString() });
                    }}
                  />

                  {isNullOperator ? (
                    <div className="flex h-9 items-center rounded-xl border border-slate-100 bg-white px-3 text-xs text-slate-500">
                      مقدار لازم نیست
                    </div>
                  ) : valueOptions.length > 0 ? (
                    <SuperAdminTableSelect
                      buttonClassName="!p-1.5"
                      iconClassName="!h-5 !w-5"
                      selectedOption={item.value}
                      options={[{ id: "", title: "مقدار" }, ...valueOptions]}
                      onOptionSelect={(id) => {
                        updateDraftItem(index, { value: id.toString() });
                      }}
                    />
                  ) : (
                    <Input
                      placeholder="مقدار"
                      type={
                        selectedField?.type === "number"
                          ? "number"
                          : selectedField?.type === "date"
                            ? "date"
                            : "text"
                      }
                      className="h-9 !text-xs"
                      parentClassName="w-full"
                      value={item.value}
                      onChange={(e) => {
                        updateDraftItem(index, { value: e.target.value });
                      }}
                      variant="auth"
                      size="sm"
                    />
                  )}

                  <button
                    type="button"
                    className="flex h-9 w-full items-center justify-center rounded-lg bg-white sm:w-9"
                    onClick={() => {
                      setDraft((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
                    }}
                    aria-label="حذف فیلتر"
                  >
                    <FilterCloseIcon />
                  </button>
                </div>
              );
            })}
          </div>

          {draftHasInvalidRows && (
            <p className="text-xs text-red-600">
              برای اعمال فیلتر، فیلد، عملگر و مقدار هر ردیف را کامل کنید.
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              className="flex items-center justify-center gap-1 rounded-lg bg-slate-50 px-2 py-2 sm:justify-start"
              onClick={clearFilters}
            >
              <TrashIcon />
              <span className="text-xs text-actions-primary">پاک کردن فیلترها</span>
            </button>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <button
                type="button"
                className="flex h-9 items-center justify-center gap-1 rounded-md border border-actions-primary bg-white px-2 text-actions-primary sm:h-8"
                onClick={() => {
                  setDraft((prev) => [...prev, { ...EMPTY_FILTER }]);
                }}
              >
                <WhitePlusIcon />
                <span className="text-xs">افزودن فیلتر</span>
              </button>

              <button
                type="button"
                data-testid="advanced-filter-apply"
                className="flex h-9 items-center justify-center rounded-md bg-actions-primary px-3 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50 sm:h-8"
                onClick={applyFilters}
                disabled={draftHasInvalidRows}
              >
                اعمال فیلتر
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
