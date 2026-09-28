import React, { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/services";

type Option = {
  label: string;
  value: string;
};

type Props = {
  provinceValue: string;
  cityValue: string;
  onProvinceChange: (value: string) => void;
  onCityChange: (value: string) => void;
  readOnly?: boolean;
  provincePlaceholder?: string;
  cityPlaceholder?: string;
  formData?: any;
};

// The default page size is 25 and Iran has 31 provinces.
const PROVINCES_URL = "/shipping-provinces?pagination[pageSize]=100&sort=Title:asc";
const citiesUrl = (provinceId: string) =>
  `/shipping-cities?filters[shipping_province][id][$eq]=${encodeURIComponent(provinceId)}` +
  "&pagination[pageSize]=500&sort=Title:asc";

// Strapi collection rows, `{ id, attributes: { Title } }` or flattened `{ id, Title }`.
const toOptions = (response: any): Option[] => {
  const rows = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.data?.data)
      ? response.data.data
      : [];
  return rows
    .map((row: any) => ({
      value: String(row?.id ?? ""),
      label: String(row?.attributes?.Title ?? row?.Title ?? "").trim(),
    }))
    .filter((option: Option) => option.value && option.label);
};

export default function ProvinceCityField({
  provinceValue,
  cityValue,
  onProvinceChange,
  onCityChange,
  readOnly,
  provincePlaceholder = "انتخاب استان",
  cityPlaceholder = "انتخاب شهر",
}: Props) {
  const [provinceOptions, setProvinceOptions] = useState<Option[]>([]);
  const [cityOptions, setCityOptions] = useState<Option[]>([]);
  const [loadingProvinces, setLoadingProvinces] = useState(false);
  const [loadingCities, setLoadingCities] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadingProvinces(true);
    apiClient
      .get(PROVINCES_URL)
      .then((response) => {
        if (!cancelled) setProvinceOptions(toOptions(response));
      })
      .catch((fetchError) => {
        console.error("Error fetching provinces:", fetchError);
        if (!cancelled) setError("فهرست استان‌ها دریافت نشد");
      })
      .finally(() => {
        if (!cancelled) setLoadingProvinces(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Keyed on the value, not on a change event, so a province passed in
  // pre-filled (e.g. an order's current address) lists its cities too.
  useEffect(() => {
    if (!provinceValue) {
      setCityOptions([]);
      return;
    }
    let cancelled = false;
    setLoadingCities(true);
    apiClient
      .get(citiesUrl(provinceValue))
      .then((response) => {
        if (!cancelled) setCityOptions(toOptions(response));
      })
      .catch((fetchError) => {
        console.error("Error fetching cities:", fetchError);
        if (!cancelled) {
          setCityOptions([]);
          setError("فهرست شهرها دریافت نشد");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCities(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provinceValue, attempt]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  const handleProvinceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onProvinceChange(e.target.value);
    // Reset city when province changes
    onCityChange("");
  };

  const selectClass = (busy: boolean) =>
    `text-sm w-full border-l-[20px] border-transparent px-5 py-3 ${
      readOnly ? "bg-slate-100 text-slate-500" : ""
    } ${busy ? "opacity-50" : ""}`;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-4">
        {/* Province Dropdown */}
        <div className="w-full overflow-hidden rounded-lg border border-neutral-200">
          <div className="relative">
            <select
              aria-label="استان"
              className={selectClass(loadingProvinces)}
              disabled={readOnly || loadingProvinces}
              value={provinceValue}
              onChange={handleProvinceChange}
            >
              <option value="">{provincePlaceholder}</option>
              {provinceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* City Dropdown */}
        <div className="w-full overflow-hidden rounded-lg border border-neutral-200">
          <div className="relative">
            <select
              aria-label="شهر"
              className={selectClass(loadingCities)}
              disabled={readOnly || !provinceValue || loadingCities}
              value={cityValue}
              onChange={(e) => onCityChange(e.target.value)}
            >
              <option value="">{cityPlaceholder}</option>
              {cityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="flex items-center gap-2 text-xs text-red-600">
          {error}
          <button type="button" className="underline" onClick={retry}>
            تلاش دوباره
          </button>
        </p>
      )}
    </div>
  );
}
