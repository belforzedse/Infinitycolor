import type { AdminShippingMethodOption } from "@/services/super-admin/orders/list";

type Props = {
  methods: AdminShippingMethodOption[];
  selectedCodes: string[];
  loading: boolean;
  failed: boolean;
  onToggle: (code: string) => void;
  onClear: () => void;
};

export default function ShippingMethodFilters({
  methods,
  selectedCodes,
  loading,
  failed,
  onToggle,
  onClear,
}: Props) {
  return (
    <fieldset className="mb-3 min-w-0 rounded-2xl border border-neutral-200 bg-white/70 p-3">
      <legend className="px-1 text-sm font-medium text-neutral-700">
        روش‌های ارسال
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        {loading && (
          <span className="text-xs text-neutral-500">در حال دریافت...</span>
        )}

        {!loading && failed && (
          <span className="text-xs text-red-600">
            دریافت روش‌های ارسال انجام نشد.
          </span>
        )}

        {!loading && !failed && methods.length === 0 && (
          <span className="text-xs text-neutral-500">روشی ثبت نشده است.</span>
        )}

        {!loading &&
          !failed &&
          methods.map((method) => {
            const checked = selectedCodes.includes(method.code);
            return (
              <label
                key={method.code}
                className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                  checked
                    ? "border-infinity-primary bg-infinity-primary-lighter/30 text-infinity-primary"
                    : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300"
                }`}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 accent-infinity-primary"
                  checked={checked}
                  onChange={() => onToggle(method.code)}
                />
                <span>{method.title}</span>
              </label>
            );
          })}

        {selectedCodes.length > 0 && (
          <button
            type="button"
            className="min-h-10 px-2 text-xs text-neutral-500 hover:text-neutral-700"
            onClick={onClear}
          >
            نمایش همه
          </button>
        )}
      </div>
    </fieldset>
  );
}
