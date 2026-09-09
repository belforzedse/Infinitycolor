"use client";

import { useEffect, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import type { ReportFilters } from "./useReportFilters";
import { getAllCategories } from "@/services/super-admin/product/category/getAll";

const inputCls =
  "h-10 w-full rounded-lg border border-neutral-300 px-3 text-sm focus:border-transparent focus:ring-2 focus:ring-infinity-primary";

/**
 * Product-report extra filters (search / category / type / stock).
 *
 * The sales workspace layout already owns the reporting period, so this bar
 * must not render a second pair of date pickers. It is only mounted on the
 * performance tab via `showProductFilters`.
 */
export default function FilterBar({
  f,
  showProductFilters,
}: {
  f: ReportFilters;
  showProductFilters?: boolean;
}) {
  const [categories, setCategories] = useState<Array<{ id: number; title: string }>>([]);
  const [search, setSearch] = useState(f.q);

  const debounced = useDebouncedCallback((v: string) => f.setQ(v), 500);

  useEffect(() => {
    if (!showProductFilters) {
      setCategories([]);
      return;
    }

    getAllCategories()
      .then((res) => {
        const list = (res?.data || []).map((category) => ({
          id: category.id,
          title: category.attributes?.Title || `#${category.id}`,
        }));
        setCategories(list);
      })
      .catch(() => setCategories([]));
  }, [showProductFilters]);

  if (!showProductFilters) return null;

  return (
    <div className="rounded-2xl bg-white p-4" dir="rtl">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5 lg:col-span-2">
            <label className="text-sm font-medium text-neutral-600">جستجوی نام / SKU</label>
            <input
              className={inputCls}
              value={search}
              placeholder="نام محصول یا کد..."
              onChange={(e) => {
                setSearch(e.target.value);
                debounced(e.target.value);
              }}
              inputMode="search"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-neutral-600">دسته‌بندی</label>
            <select className={inputCls} value={f.cat} onChange={(e) => f.setCat(e.target.value)}>
              <option value="">همه دسته‌ها</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-neutral-600">نوع محصول</label>
            <select
              className={inputCls}
              value={f.ptype}
              onChange={(e) => f.setPtype(e.target.value)}
            >
              <option value="">همه</option>
              <option value="Variable">متغیر</option>
              <option value="Simple">ساده</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-neutral-600">وضعیت موجودی</label>
            <select
              className={inputCls}
              value={f.stock}
              onChange={(e) => f.setStock(e.target.value)}
            >
              <option value="">همه</option>
              <option value="in">موجود</option>
              <option value="low">کم</option>
              <option value="out">ناموجود</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
