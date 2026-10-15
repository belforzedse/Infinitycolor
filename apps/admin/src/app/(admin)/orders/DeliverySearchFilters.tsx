"use client";
import ProvinceCityField from "@/components/SuperAdmin/UpsertPage/ContentWrapper/Fields/ProvinceCityField";
import type { useOrderDeliverySearch } from "@/hooks/useOrderDeliverySearch";

type Props = Pick<
  ReturnType<typeof useOrderDeliverySearch>,
  "draft" | "change" | "clear" | "active"
>;
export default function DeliverySearchFilters({
  draft,
  change,
  clear,
  active,
}: Props) {
  return (
    <div
      className="mb-3 grid grid-cols-1 gap-3 rounded-2xl bg-white p-3 sm:grid-cols-2 xl:grid-cols-4"
      dir="rtl"
    >
      <div className="space-y-1 text-sm text-neutral-600">
        <span>شهر</span>
        <ProvinceCityField
          provinceValue={draft.provinceId}
          cityValue={draft.cityId}
          onProvinceChange={(value) => change("provinceId", value)}
          onCityChange={(value) => change("cityId", value)}
        />
      </div>
      {(
        [
          ["productCode", "کد محصول", 255, "text"],
          ["postalCode", "کد پستی", 30, "numeric"],
          ["addressText", "آدرس مشتری", 200, "text"],
        ] as const
      ).map(([key, label, maxLength, inputMode]) => (
        <label key={key} className="space-y-1 text-sm text-neutral-600">
          <span>{label}</span>
          <input
            className="h-10 w-full rounded-lg border border-neutral-300 px-3 text-sm"
            aria-label={label}
            value={draft[key]}
            onChange={(event) => change(key, event.target.value)}
            maxLength={maxLength}
            inputMode={inputMode}
            dir={key === "addressText" ? "rtl" : "ltr"}
          />
        </label>
      ))}
      {(active || Object.values(draft).some(Boolean)) && (
        <button
          type="button"
          onClick={clear}
          className="justify-self-start text-sm text-neutral-600 hover:text-neutral-900"
        >
          پاک کردن جستجوی آدرس و محصول
        </button>
      )}
    </div>
  );
}
