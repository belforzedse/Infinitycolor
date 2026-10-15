"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import HomepageProductPicker, {
  type ProductSummary,
} from "@/components/SuperAdmin/Products/HomepageProductPicker";
import { HOMEPAGE_RENDER_LIMIT } from "@/constants/homepage";
import {
  getHomepageProductSettings,
  updateHomepageProductSettings,
} from "@/services/super-admin/settings/homepageProducts";
import { getProductSummariesByIds } from "@/services/super-admin/product/get";
import { useEditorRedirect } from "@/hooks/useEditorRedirect";

function EnabledToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 accent-infinity-primary"
      />
      {label}
    </label>
  );
}

export default function HomepageProductsPage() {
  useEditorRedirect();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [homepageRevision, setHomepageRevision] = useState<number | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [newestIds, setNewestIds] = useState<number[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<number[]>([]);
  const [discountedIds, setDiscountedIds] = useState<number[]>([]);
  const [weeklyPicksEnabled, setWeeklyPicksEnabled] = useState(false);
  const [weeklyPicksIds, setWeeklyPicksIds] = useState<number[]>([]);
  const [everyoneFollowsEnabled, setEveryoneFollowsEnabled] = useState(false);
  const [everyoneFollowsIds, setEveryoneFollowsIds] = useState<number[]>([]);

  const [newestSummaries, setNewestSummaries] = useState<ProductSummary[]>([]);
  const [favoriteSummaries, setFavoriteSummaries] = useState<ProductSummary[]>(
    [],
  );
  const [discountedSummaries, setDiscountedSummaries] = useState<
    ProductSummary[]
  >([]);
  const [weeklyPicksSummaries, setWeeklyPicksSummaries] = useState<
    ProductSummary[]
  >([]);
  const [everyoneFollowsSummaries, setEveryoneFollowsSummaries] = useState<
    ProductSummary[]
  >([]);

  const loadSettingsAndSummaries = useCallback(async () => {
    try {
      const settings = await getHomepageProductSettings();
      setHomepageRevision(settings.HomepageProductsRevision);
      setConflicted(false);
      setNewestIds(settings.homeNewestProductIds);
      setFavoriteIds(settings.homeFavoriteProductIds);
      setDiscountedIds(settings.homeDiscountedProductIds);
      setWeeklyPicksEnabled(settings.homeWeeklyPicksEnabled);
      setWeeklyPicksIds(settings.homeWeeklyPicksProductIds);
      setEveryoneFollowsEnabled(settings.homeEveryoneFollowsEnabled);
      setEveryoneFollowsIds(settings.homeEveryoneFollowsProductIds);

      const [newest, favorites, discounted, weeklyPicks, everyoneFollows] =
        await Promise.all([
          getProductSummariesByIds(settings.homeNewestProductIds),
          getProductSummariesByIds(settings.homeFavoriteProductIds),
          getProductSummariesByIds(settings.homeDiscountedProductIds),
          getProductSummariesByIds(settings.homeWeeklyPicksProductIds),
          getProductSummariesByIds(settings.homeEveryoneFollowsProductIds),
        ]);
      setNewestSummaries(newest);
      setFavoriteSummaries(favorites);
      setDiscountedSummaries(discounted);
      setWeeklyPicksSummaries(weeklyPicks);
      setEveryoneFollowsSummaries(everyoneFollows);
    } catch (err) {
      console.error(err);
      toast.error("خطا در دریافت تنظیمات. دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettingsAndSummaries();
  }, [loadSettingsAndSummaries]);

  const newestSummariesForPicker = useMemo(
    () => newestSummaries.filter((s) => newestIds.includes(s.id)),
    [newestSummaries, newestIds],
  );
  const favoriteSummariesForPicker = useMemo(
    () => favoriteSummaries.filter((s) => favoriteIds.includes(s.id)),
    [favoriteSummaries, favoriteIds],
  );
  const discountedSummariesForPicker = useMemo(
    () => discountedSummaries.filter((s) => discountedIds.includes(s.id)),
    [discountedSummaries, discountedIds],
  );
  const weeklyPicksSummariesForPicker = useMemo(
    () => weeklyPicksSummaries.filter((s) => weeklyPicksIds.includes(s.id)),
    [weeklyPicksSummaries, weeklyPicksIds],
  );
  const everyoneFollowsSummariesForPicker = useMemo(
    () =>
      everyoneFollowsSummaries.filter((s) => everyoneFollowsIds.includes(s.id)),
    [everyoneFollowsSummaries, everyoneFollowsIds],
  );

  const handleSave = async () => {
    if (homepageRevision === null || conflicted) return;
    setSaving(true);
    try {
      const saved = await updateHomepageProductSettings(
        {
          homeNewestProductIds: newestIds,
          homeFavoriteProductIds: favoriteIds,
          homeDiscountedProductIds: discountedIds,
          homeWeeklyPicksEnabled: weeklyPicksEnabled,
          homeWeeklyPicksProductIds: weeklyPicksIds,
          homeEveryoneFollowsEnabled: everyoneFollowsEnabled,
          homeEveryoneFollowsProductIds: everyoneFollowsIds,
        },
        homepageRevision,
      );
      toast.success("تنظیمات با موفقیت ذخیره شد");
      const settings = saved ?? (await getHomepageProductSettings());
      setHomepageRevision(settings.HomepageProductsRevision);
      setConflicted(false);
      setNewestIds(settings.homeNewestProductIds);
      setFavoriteIds(settings.homeFavoriteProductIds);
      setDiscountedIds(settings.homeDiscountedProductIds);
      setWeeklyPicksEnabled(settings.homeWeeklyPicksEnabled);
      setWeeklyPicksIds(settings.homeWeeklyPicksProductIds);
      setEveryoneFollowsEnabled(settings.homeEveryoneFollowsEnabled);
      setEveryoneFollowsIds(settings.homeEveryoneFollowsProductIds);

      const [newest, favorites, discounted, weeklyPicks, everyoneFollows] =
        await Promise.all([
          getProductSummariesByIds(settings.homeNewestProductIds),
          getProductSummariesByIds(settings.homeFavoriteProductIds),
          getProductSummariesByIds(settings.homeDiscountedProductIds),
          getProductSummariesByIds(settings.homeWeeklyPicksProductIds),
          getProductSummariesByIds(settings.homeEveryoneFollowsProductIds),
        ]);
      setNewestSummaries(newest);
      setFavoriteSummaries(favorites);
      setDiscountedSummaries(discounted);
      setWeeklyPicksSummaries(weeklyPicks);
      setEveryoneFollowsSummaries(everyoneFollows);
    } catch (err) {
      if (
        (err as { status?: number }).status === 409 ||
        !(err as { status?: number }).status
      )
        setConflicted(true);
      console.error(err);
      toast.error("خطا در ذخیره. دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <ContentWrapper title="محصولات صفحه اصلی">
        <div className="p-4 text-neutral-600">در حال بارگذاری...</div>
      </ContentWrapper>
    );
  }

  return (
    <ContentWrapper title="محصولات صفحه اصلی">
      {conflicted && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"
        >
          تنظیمات تغییر کرده یا نتیجه ذخیره تأیید نشده است. انتخاب‌های شما در
          این صفحه محفوظ است.
          <button
            className="mr-3 rounded-lg border px-3 py-2"
            onClick={() => {
              if (
                window.confirm(
                  "انتخاب‌های این صفحه با آخرین تنظیمات جایگزین شود؟",
                )
              )
                void loadSettingsAndSummaries();
            }}
          >
            بارگذاری دوباره
          </button>
        </div>
      )}

      <div className="space-y-6 p-4">
        <p className="rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-sm text-blue-800">
          اگر برای هر بخش محصولی انتخاب نشود، محصولات به صورت خودکار (جدیدترین،
          محبوب‌ترین یا دارای تخفیف) نمایش داده می‌شوند. برای «جدیدترین ها»،
          «محبوب ترین ها» و «تخفیف‌های وسوسه انگیز»، محصولات انتخاب‌شده هم در
          اسلایدر صفحه اصلی و هم در ابتدای صفحه «مشاهده همه» با همین ترتیب نمایش
          داده می‌شوند؛ باقی محصولات صفحه پس از آن‌ها با ترتیب معمول ظاهر
          می‌شوند.
        </p>

        <div className="grid gap-6 lg:grid-cols-2">
          <HomepageProductPicker
            title="جدیدترین ها — صفحه اصلی و مشاهده همه"
            selectedProductIds={newestIds}
            productSummaries={newestSummariesForPicker}
            onProductsChange={setNewestIds}
            onProductAdded={(p) => setNewestSummaries((prev) => [...prev, p])}
            renderLimit={HOMEPAGE_RENDER_LIMIT}
            sectionKind="newest"
          />
          <HomepageProductPicker
            title="محبوب ترین ها — صفحه اصلی و مشاهده همه"
            selectedProductIds={favoriteIds}
            productSummaries={favoriteSummariesForPicker}
            onProductsChange={setFavoriteIds}
            onProductAdded={(p) => setFavoriteSummaries((prev) => [...prev, p])}
            renderLimit={HOMEPAGE_RENDER_LIMIT}
            sectionKind="popular"
          />
          <HomepageProductPicker
            title="تخفیف‌های وسوسه انگیز — صفحه اصلی و مشاهده همه"
            selectedProductIds={discountedIds}
            productSummaries={discountedSummariesForPicker}
            onProductsChange={setDiscountedIds}
            onProductAdded={(p) =>
              setDiscountedSummaries((prev) => [...prev, p])
            }
            renderLimit={HOMEPAGE_RENDER_LIMIT}
            sectionKind="discount"
          />

          <div className="space-y-3">
            <EnabledToggle
              label="نمایش بخش «منتخب‌های این هفته»"
              checked={weeklyPicksEnabled}
              onChange={setWeeklyPicksEnabled}
            />
            <HomepageProductPicker
              title="منتخب‌های این هفته"
              selectedProductIds={weeklyPicksIds}
              productSummaries={weeklyPicksSummariesForPicker}
              onProductsChange={setWeeklyPicksIds}
              onProductAdded={(p) =>
                setWeeklyPicksSummaries((prev) => [...prev, p])
              }
              renderLimit={HOMEPAGE_RENDER_LIMIT}
            />
          </div>

          <div className="space-y-3">
            <EnabledToggle
              label="نمایش بخش «همه دنبالشَن»"
              checked={everyoneFollowsEnabled}
              onChange={setEveryoneFollowsEnabled}
            />
            <HomepageProductPicker
              title="همه دنبالشَن"
              selectedProductIds={everyoneFollowsIds}
              productSummaries={everyoneFollowsSummariesForPicker}
              onProductsChange={setEveryoneFollowsIds}
              onProductAdded={(p) =>
                setEveryoneFollowsSummaries((prev) => [...prev, p])
              }
              renderLimit={HOMEPAGE_RENDER_LIMIT}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || conflicted || homepageRevision === null}
            className="rounded-xl bg-infinity-primary px-6 py-2.5 text-white transition hover:bg-infinity-primary-dark disabled:opacity-50"
          >
            {saving ? "در حال ذخیره..." : "ذخیره تغییرات"}
          </button>
        </div>
      </div>
    </ContentWrapper>
  );
}
