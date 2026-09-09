"use client";

import SearchIcon from "@/components/Kits/Icons/SearchIcon";
import FamilyColorSwatch from "./FamilyColorSwatch";
import type { ColorFamilyBucket } from "@/utils/plpColorFilter";
import { colorFamilyMatchesQuery } from "@/utils/plpColorFilter";
import { useMemo, useState } from "react";

interface ColorFilterProps {
  buckets: ColorFamilyBucket[];
  selectedKeys: string[];
  isLoading?: boolean;
  onToggle: (key: string) => void;
}

export default function ColorFilter({
  buckets,
  selectedKeys,
  isLoading = false,
  onToggle,
}: ColorFilterProps) {
  const [search, setSearch] = useState("");
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);

  const visibleBuckets = useMemo(
    () => buckets.filter((bucket) => colorFamilyMatchesQuery(bucket, search)),
    [buckets, search],
  );

  return (
    <div className="rounded-lg bg-white" data-testid="plp-color-options">
      <div className="flex items-center justify-between border-b border-slate-50 p-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="جستجوی رنگ"
          aria-label="جستجوی رنگ"
          data-testid="plp-color-search"
          className="text-xs flex-grow bg-transparent text-right text-neutral-600 outline-none"
        />
        <div className="h-5 w-5">
          <SearchIcon />
        </div>
      </div>
      <div className="max-h-[220px] overflow-y-auto px-2 py-2">
        {isLoading ? (
          <p className="py-3 text-right text-xs text-neutral-500">در حال بارگذاری رنگ‌ها…</p>
        ) : visibleBuckets.length === 0 ? (
          <p className="py-3 text-right text-xs text-neutral-500">رنگی پیدا نشد. دوباره تلاش کنید</p>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            {visibleBuckets.map((bucket) => {
              const isSelected = selected.has(bucket.key);
              return (
                <button
                  key={bucket.key}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={bucket.label}
                  data-testid={`plp-color-option-${bucket.key}`}
                  onClick={() => onToggle(bucket.key)}
                  className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition ${
                    isSelected
                      ? "border-infinity-primary bg-infinity-primary-lighter/20 text-infinity-primary-dark"
                      : "border-slate-200 bg-white text-neutral-700 hover:border-infinity-primary-lighter/60"
                  }`}
                >
                  <FamilyColorSwatch
                    shades={bucket.shades}
                    label={bucket.label}
                    selected={isSelected}
                  />
                  <span>{bucket.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
