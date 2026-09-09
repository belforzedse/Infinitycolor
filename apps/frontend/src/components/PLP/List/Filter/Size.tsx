"use client";

import CheckIcon from "@/components/Kits/Icons/CheckIcon";
import SearchIcon from "@/components/Kits/Icons/SearchIcon";
import type { SizeBucket } from "@/utils/plpSizeFilter";
import { sizeBucketMatchesQuery } from "@/utils/plpSizeFilter";
import { useMemo, useState } from "react";

interface SizeFilterProps {
  buckets: SizeBucket[];
  selectedKeys: string[];
  isLoading?: boolean;
  onToggle: (key: string) => void;
}

export default function SizeFilter({
  buckets,
  selectedKeys,
  isLoading = false,
  onToggle,
}: SizeFilterProps) {
  const [search, setSearch] = useState("");
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);

  const visibleBuckets = useMemo(
    () => buckets.filter((bucket) => sizeBucketMatchesQuery(bucket, search)),
    [buckets, search],
  );

  return (
    <div className="rounded-lg bg-white" data-testid="plp-size-options">
      <div className="flex items-center justify-between border-b border-slate-50 p-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="جستجوی سایز"
          aria-label="جستجوی سایز"
          data-testid="plp-size-search"
          className="text-xs flex-grow bg-transparent text-right text-neutral-600 outline-none"
        />
        <div className="h-5 w-5">
          <SearchIcon />
        </div>
      </div>
      <div className="max-h-[220px] overflow-y-auto px-2">
        {isLoading ? (
          <p className="py-3 text-right text-xs text-neutral-500">در حال بارگذاری سایزها…</p>
        ) : visibleBuckets.length === 0 ? (
          <p className="py-3 text-right text-xs text-neutral-500">سایزی پیدا نشد. دوباره تلاش کنید</p>
        ) : (
          <div className="flex flex-col py-1">
            {visibleBuckets.map((bucket) => {
              const isSelected = selected.has(bucket.key);
              return (
                <button
                  key={bucket.key}
                  type="button"
                  aria-pressed={isSelected}
                  data-testid={`plp-size-option-${bucket.key}`}
                  onClick={() => onToggle(bucket.key)}
                  className="flex w-full flex-row-reverse items-center justify-end gap-2 py-2 text-right"
                >
                  <span className="text-primary text-sm">{bucket.label}</span>
                  {isSelected ? (
                    <CheckIcon className="h-4 w-4 rounded" />
                  ) : (
                    <span className="h-4 w-4 rounded border border-slate-300" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
