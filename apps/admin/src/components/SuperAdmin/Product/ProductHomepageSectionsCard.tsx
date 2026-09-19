"use client";

import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { HOMEPAGE_RENDER_LIMIT } from "@/constants/homepage";
import { getProductSummariesByIds } from "@/services/super-admin/product/get";
import {
  getHomepageProductSettings,
  updateHomepageProductSettings,
} from "@/services/super-admin/settings/homepageProducts";
import type { SuperAdminSettings } from "@/types/super-admin/settings";
import { faNum } from "@/utils/faNum";

type SectionField =
  | "homeNewestProductIds"
  | "homeFavoriteProductIds"
  | "homeDiscountedProductIds";

/**
 * Only the three rails that also drive a «مشاهده همه» listing page. «منتخب‌های این هفته»
 * and «همه دنبال می‌کنند» are deliberately left to /products/homepage: they each have an
 * enable toggle, so a checkbox here could look like it did something while the section
 * itself is switched off.
 */
const SECTIONS: readonly { field: SectionField; label: string }[] = [
  { field: "homeNewestProductIds", label: "جدیدترین ها" },
  { field: "homeFavoriteProductIds", label: "محبوب ترین ها" },
  { field: "homeDiscountedProductIds", label: "تخفیف‌های وسوسه انگیز" },
];

type Lists = Record<SectionField, number[]>;
type Checked = Record<SectionField, boolean>;

function listsFromSettings(settings: SuperAdminSettings): Lists {
  return {
    homeNewestProductIds: settings.homeNewestProductIds,
    homeFavoriteProductIds: settings.homeFavoriteProductIds,
    homeDiscountedProductIds: settings.homeDiscountedProductIds,
  };
}

function checkedFromLists(lists: Lists, productId: number): Checked {
  return {
    homeNewestProductIds: lists.homeNewestProductIds.includes(productId),
    homeFavoriteProductIds: lists.homeFavoriteProductIds.includes(productId),
    homeDiscountedProductIds: lists.homeDiscountedProductIds.includes(productId),
  };
}

type Props = {
  productId: number;
};

/**
 * Per-product view of the curated homepage rails, so an operator can put the product
 * they already have open into «جدیدترین ها» without going to /products/homepage and
 * searching for it again.
 *
 * Checking a box PREPENDS the product (index 0), pushing everything else down — that is
 * what «جدیدترین» means, and it also keeps the product clear of the 20-item carousel
 * slice the backend applies (HOMEPAGE_RENDER_LIMIT). Appending would silently bury it
 * on any section that is already full.
 *
 * Note that each rail falls back to an algorithm when its manual list is EMPTY (see
 * `newestPromise`/`discountedPromise` in api/product/services/product.ts). So the first
 * check takes the section off automatic, and removing the last item puts it back — both
 * are called out in the UI, because neither is obvious from a checkbox.
 */
export default function ProductHomepageSectionsCard({ productId }: Props) {
  const [lists, setLists] = useState<Lists | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [saving, setSaving] = useState(false);
  const [eligible, setEligible] = useState<boolean | undefined>(undefined);
  const [discounted, setDiscounted] = useState<boolean | undefined>(undefined);

  const applySettings = useCallback(
    (settings: SuperAdminSettings) => {
      const next = listsFromSettings(settings);
      setLists(next);
      setChecked(checkedFromLists(next, productId));
    },
    [productId],
  );

  useEffect(() => {
    let cancelled = false;
    // Until this product's own read lands, nothing from the previously opened product
    // may stay on screen: `isDirty` compares the checkboxes against `lists` for the
    // CURRENT id, so a stale list would offer a save that curates the wrong product.
    setLists(null);
    setChecked(null);
    getHomepageProductSettings()
      .then((settings) => {
        if (!cancelled) applySettings(settings);
      })
      .catch(() => {
        if (!cancelled) toast.error("خطا در دریافت بخش‌های صفحه اصلی");
      });
    return () => {
      cancelled = true;
    };
  }, [applySettings]);

  useEffect(() => {
    let cancelled = false;
    // Same eligibility the picker badges use, rather than reading the edit form: it
    // reflects what is SAVED, which is what the storefront will actually render.
    getProductSummariesByIds([productId])
      .then(([summary]) => {
        if (cancelled || !summary) return;
        setEligible(summary.isEligible);
        setDiscounted(summary.isDiscounted);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const toggle = (field: SectionField) =>
    setChecked((prev) => (prev ? { ...prev, [field]: !prev[field] } : prev));

  const isDirty = Boolean(
    lists &&
      checked &&
      SECTIONS.some(({ field }) => lists[field].includes(productId) !== checked[field]),
  );

  const handleSave = async () => {
    if (!checked || saving) return;
    setSaving(true);
    try {
      // Re-read instead of trusting the mount-time snapshot: this card sits on a page an
      // operator can leave open for a long time, and /products/homepage writes the same
      // rows. Applying our one-product delta to the freshly read arrays keeps whatever
      // reordering happened in between.
      const fresh = await getHomepageProductSettings();
      const freshLists = listsFromSettings(fresh);
      const payload: Partial<Record<SectionField, number[]>> = {};

      SECTIONS.forEach(({ field }) => {
        const current = freshLists[field];
        const without = current.filter((id) => id !== productId);
        if (current.includes(productId) === checked[field]) return;
        payload[field] = checked[field] ? [productId, ...without] : without;
      });

      if (Object.keys(payload).length === 0) {
        applySettings(fresh);
        toast("تغییری برای ذخیره وجود ندارد");
        return;
      }

      applySettings(await updateHomepageProductSettings(payload));
      toast.success("بخش‌های صفحه اصلی این محصول ذخیره شد");
    } catch {
      toast.error("خطا در ذخیره بخش‌های صفحه اصلی");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      dir="rtl"
      data-testid="product-homepage-sections"
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-right shadow-sm"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-slate-900">بخش‌های صفحه اصلی</h3>
        <p className="text-xs leading-5 text-slate-500">
          با انتخاب هر بخش، این محصول در ابتدای همان بخش (جایگاه ۱) قرار می‌گیرد و بقیه محصولات یک
          جایگاه پایین‌تر می‌روند. برای مرتب‌سازی کامل به «محصولات صفحه اصلی» بروید.
        </p>
      </div>

      {eligible === false && (
        <p className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
          این محصول در حال حاضر در فروشگاه نمایش داده نمی‌شود (غیرفعال، منتشرنشده یا بدون قیمت)؛
          تا زمانی که این مشکل برطرف نشود، انتخاب بخش‌ها اثری در صفحه اصلی ندارد.
        </p>
      )}

      {!lists || !checked ? (
        <p className="text-xs text-slate-500">در حال بارگذاری...</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {SECTIONS.map(({ field, label }) => {
            const saved = lists[field];
            const index = saved.indexOf(productId);
            const isSaved = index >= 0;
            const position = index + 1;
            const pastRenderLimit = isSaved && position > HOMEPAGE_RENDER_LIMIT;
            const turnsManual = checked[field] && saved.length === 0;
            const turnsAutomatic =
              !checked[field] && saved.length === 1 && saved[0] === productId;
            const staleDiscount =
              field === "homeDiscountedProductIds" && checked[field] && discounted === false;

            return (
              <li
                key={field}
                className="rounded-lg border border-neutral-100 bg-neutral-50/50 p-2"
              >
                <label className="flex cursor-pointer items-center justify-between gap-2 text-sm text-slate-700">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked[field]}
                      onChange={() => toggle(field)}
                      disabled={saving}
                      data-testid={`homepage-section-${field}`}
                      className="h-4 w-4 rounded border-slate-300 accent-infinity-primary"
                    />
                    {label}
                  </span>
                  {isSaved && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                        pastRenderLimit
                          ? "bg-amber-100 text-amber-700"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      جایگاه {faNum(position)} از {faNum(saved.length)}
                    </span>
                  )}
                </label>

                {!isSaved && checked[field] && (
                  <p className="mt-1 pr-6 text-xs text-slate-500">
                    پس از ذخیره در جایگاه ۱ قرار می‌گیرد.
                  </p>
                )}
                {isSaved && !checked[field] && (
                  <p className="mt-1 pr-6 text-xs text-slate-500">
                    با ذخیره، از این بخش حذف می‌شود.
                  </p>
                )}
                {pastRenderLimit && checked[field] && (
                  <p className="mt-1 pr-6 text-xs text-amber-700">
                    جایگاه {faNum(position)} از حد {faNum(HOMEPAGE_RENDER_LIMIT)}تایی اسلایدر صفحه
                    اصلی بیرون است و فقط در «مشاهده همه» دیده می‌شود. برای جابه‌جایی به «محصولات
                    صفحه اصلی» بروید.
                  </p>
                )}
                {turnsManual && (
                  <p className="mt-1 pr-6 text-xs text-amber-700">
                    این بخش اکنون خودکار پر می‌شود؛ با ذخیره، فقط محصولات انتخاب‌شده در آن نمایش
                    داده می‌شوند.
                  </p>
                )}
                {turnsAutomatic && (
                  <p className="mt-1 pr-6 text-xs text-amber-700">
                    این آخرین محصول انتخاب‌شده این بخش است؛ با ذخیره، بخش دوباره خودکار می‌شود.
                  </p>
                )}
                {staleDiscount && (
                  <p className="mt-1 pr-6 text-xs text-amber-700">
                    این محصول تخفیف فعالی ندارد و بدون برچسب تخفیف در این بخش دیده می‌شود.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving || !isDirty}
        data-testid="homepage-sections-save"
        className="rounded-lg bg-actions-primary px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "در حال ذخیره..." : "ذخیره بخش‌های صفحه اصلی"}
      </button>
    </div>
  );
}
