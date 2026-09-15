"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import HomepageProductPicker, {
  type ProductSummary,
} from "@/components/SuperAdmin/Products/HomepageProductPicker";
import ProductSmallCard from "@/components/Product/SmallCard";
import {
  getHomepageCustomSectionSettings,
  updateHomepageCustomSectionSettings,
} from "@/services/super-admin/settings/homepageCustomSection";
import {
  getGifPromoPreviewProducts,
  getProductSummariesByIds,
} from "@/services/super-admin/product/get";
import { fetchCategoryDropdownOptions } from "@/services/super-admin/product/category/getDropdownOptions";
import type {
  HomeGifPromoAssignment,
  SuperAdminSettings,
} from "@/types/super-admin/settings";
import logger from "@/utils/logger";
import { useEditorRedirect } from "@/hooks/useEditorRedirect";
import type { ProductCardProps } from "@/components/Product/Card";

type SectionState = {
  enabled: boolean;
  title: string;
  viewAllHref: string;
  assignment: HomeGifPromoAssignment;
  summaries: ProductSummary[];
  previewProducts: ProductCardProps[];
};

const EMPTY_STATE: SectionState = {
  enabled: false,
  title: "",
  viewAllHref: "",
  assignment: { mode: "manual", productIds: [], categorySlug: "" },
  summaries: [],
  previewProducts: [],
};

/** Mirrors the API rule: same-origin paths only, so the link can never leave the storefront. */
function isInvalidViewAllHref(value: string): boolean {
  const href = value.trim();
  if (!href) return false;
  return !href.startsWith("/") || href.startsWith("//");
}

function mapToSmallCard(product: ProductCardProps) {
  return {
    id: product.id,
    slug: product.slug,
    title: product.title,
    category: product.category,
    likedCount: product.seenCount || 0,
    price: product.price,
    discountedPrice: product.discountPrice,
    discount: product.discount,
    image: product.images.find((image) => image?.trim()) || "",
    isAvailable: product.isAvailable,
    colorsCount: product.colorsCount,
    colorCodes: product.colorCodes,
  };
}

function ProductPreview({ products }: { products: ProductCardProps[] }) {
  if (products.length === 0) {
    return (
      <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-500">
        محصولی برای نمایش پیدا نشد.
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {products.slice(0, 6).map((product) => (
        <ProductSmallCard key={product.id} {...mapToSmallCard(product)} />
      ))}
    </div>
  );
}

function SectionEditor({
  heading,
  hint,
  titlePlaceholder,
  categoryOptions,
  section,
  onEnabledChange,
  onTitleChange,
  onViewAllHrefChange,
  onAssignmentChange,
  onSummaryAdded,
}: {
  heading: string;
  hint: string;
  titlePlaceholder: string;
  categoryOptions: Array<{ label: string; value: string }>;
  section: SectionState;
  onEnabledChange: (enabled: boolean) => void;
  onTitleChange: (title: string) => void;
  onViewAllHrefChange: (viewAllHref: string) => void;
  onAssignmentChange: (assignment: HomeGifPromoAssignment) => void;
  onSummaryAdded: (product: ProductSummary) => void;
}) {
  const viewAllHrefInvalid = isInvalidViewAllHref(section.viewAllHref);

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-neutral-900">{heading}</h2>
        {section.enabled && (
          <span className="rounded-full bg-emerald-50 px-3 py-0.5 text-xs text-emerald-700">
            فعال
          </span>
        )}
      </div>

      <p className="rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-sm text-blue-800">
        {hint}
      </p>

      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={section.enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-infinity-primary"
          />
          نمایش این بخش در صفحه اصلی
        </label>
      </div>

      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
        <label className="block text-sm text-slate-600">
          عنوان بخش
          <input
            type="text"
            value={section.title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder={titlePlaceholder}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-infinity-primary focus:outline-none"
          />
        </label>

        <label className="block text-sm text-slate-600">
          لینک «مشاهده همه»
          <input
            type="text"
            dir="ltr"
            value={section.viewAllHref}
            onChange={(e) => onViewAllHrefChange(e.target.value)}
            placeholder="/plp/category/manto"
            className={`mt-1 w-full rounded-xl border bg-slate-50 px-3 py-2 text-left text-sm text-slate-900 focus:outline-none ${
              viewAllHrefInvalid
                ? "border-rose-300 focus:border-rose-400"
                : "border-slate-200 focus:border-infinity-primary"
            }`}
          />
          {viewAllHrefInvalid ? (
            <span className="mt-1 block text-xs text-rose-600">
              لینک باید یک مسیر داخلی باشد و با یک «/» شروع شود. آدرس کامل سایت پذیرفته نمی‌شود.
            </span>
          ) : (
            <span className="mt-1 block text-xs text-slate-500">
              خالی بگذارید تا به‌طور خودکار به دسته‌بندی انتخاب‌شده (یا صفحه محصولات) لینک شود.
            </span>
          )}
        </label>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-neutral-900">محصولات بخش</h3>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
            {section.assignment.mode === "manual" ? "انتخاب دستی" : "دسته بندی"}
          </span>
        </div>

        <div className="space-y-4">
          <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1 text-sm">
            <button
              type="button"
              onClick={() =>
                onAssignmentChange({
                  mode: "manual",
                  productIds:
                    section.assignment.mode === "manual" ? section.assignment.productIds : [],
                  categorySlug: "",
                })
              }
              className={`flex-1 rounded-lg px-3 py-2 ${
                section.assignment.mode === "manual"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500"
              }`}
            >
              انتخاب دستی
            </button>
            <button
              type="button"
              onClick={() =>
                onAssignmentChange({
                  mode: "category",
                  categorySlug:
                    section.assignment.mode === "category" ? section.assignment.categorySlug : "",
                  productIds: [],
                })
              }
              className={`flex-1 rounded-lg px-3 py-2 ${
                section.assignment.mode === "category"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500"
              }`}
            >
              دسته بندی
            </button>
          </div>

          {section.assignment.mode === "manual" ? (
            <HomepageProductPicker
              title="انتخاب محصولات"
              selectedProductIds={section.assignment.productIds}
              productSummaries={section.summaries}
              onProductsChange={(productIds) =>
                onAssignmentChange({ mode: "manual", productIds, categorySlug: "" })
              }
              onProductAdded={onSummaryAdded}
            />
          ) : (
            <label className="block text-sm text-slate-600">
              دسته بندی
              <select
                value={section.assignment.categorySlug}
                onChange={(e) =>
                  onAssignmentChange({
                    mode: "category",
                    categorySlug: e.target.value,
                    productIds: [],
                  })
                }
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                <option value="">انتخاب دسته بندی</option>
                {categoryOptions.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-700">پیش نمایش محصولات</h4>
            <ProductPreview products={section.previewProducts} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HomepageCustomSectionPage() {
  useEditorRedirect();

  const [sectionOne, setSectionOne] = useState<SectionState>(EMPTY_STATE);
  const [sectionTwo, setSectionTwo] = useState<SectionState>(EMPTY_STATE);
  const [sectionThree, setSectionThree] = useState<SectionState>(EMPTY_STATE);
  const [categoryOptions, setCategoryOptions] = useState<Array<{ label: string; value: string }>>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadSectionProducts = useCallback(async (assignment: HomeGifPromoAssignment) => {
    const [summaries, previewProducts] = await Promise.all([
      assignment.mode === "manual" ? getProductSummariesByIds(assignment.productIds) : [],
      getGifPromoPreviewProducts(assignment),
    ]);
    return { summaries, previewProducts };
  }, []);

  const applySettings = useCallback(
    async (loaded: SuperAdminSettings) => {
      const [one, two, three] = await Promise.all([
        loadSectionProducts(loaded.homeCustomSectionAssignment),
        loadSectionProducts(loaded.homeCustomSectionTwoAssignment),
        loadSectionProducts(loaded.homeCustomSectionThreeAssignment),
      ]);
      setSectionOne({
        enabled: loaded.homeCustomSectionEnabled,
        title: loaded.homeCustomSectionTitle,
        viewAllHref: loaded.homeCustomSectionViewAllHref,
        assignment: loaded.homeCustomSectionAssignment,
        ...one,
      });
      setSectionTwo({
        enabled: loaded.homeCustomSectionTwoEnabled,
        title: loaded.homeCustomSectionTwoTitle,
        viewAllHref: loaded.homeCustomSectionTwoViewAllHref,
        assignment: loaded.homeCustomSectionTwoAssignment,
        ...two,
      });
      setSectionThree({
        enabled: loaded.homeCustomSectionThreeEnabled,
        title: loaded.homeCustomSectionThreeTitle,
        viewAllHref: loaded.homeCustomSectionThreeViewAllHref,
        assignment: loaded.homeCustomSectionThreeAssignment,
        ...three,
      });
    },
    [loadSectionProducts],
  );

  const load = useCallback(async () => {
    try {
      const [loadedSettings, loadedCategories] = await Promise.all([
        getHomepageCustomSectionSettings(),
        fetchCategoryDropdownOptions(""),
      ]);
      setCategoryOptions(loadedCategories);
      await applySettings(loadedSettings);
    } catch (error) {
      logger.error("[HomepageCustomSection] Failed to load", { error });
      toast.error("خطا در دریافت تنظیمات");
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  const setAssignment = (
    setSection: typeof setSectionOne,
    assignment: HomeGifPromoAssignment,
  ) => {
    setSection((current) => ({ ...current, assignment }));
    void loadSectionProducts(assignment).then((products) =>
      setSection((current) => ({ ...current, ...products })),
    );
  };

  const save = async () => {
    try {
      setSaving(true);
      const saved = await updateHomepageCustomSectionSettings({
        homeCustomSectionEnabled: sectionOne.enabled,
        homeCustomSectionTitle: sectionOne.title,
        homeCustomSectionAssignment: sectionOne.assignment,
        homeCustomSectionTwoEnabled: sectionTwo.enabled,
        homeCustomSectionTwoTitle: sectionTwo.title,
        homeCustomSectionTwoAssignment: sectionTwo.assignment,
        homeCustomSectionThreeEnabled: sectionThree.enabled,
        homeCustomSectionThreeTitle: sectionThree.title,
        homeCustomSectionThreeAssignment: sectionThree.assignment,
        homeCustomSectionViewAllHref: sectionOne.viewAllHref.trim(),
        homeCustomSectionTwoViewAllHref: sectionTwo.viewAllHref.trim(),
        homeCustomSectionThreeViewAllHref: sectionThree.viewAllHref.trim(),
      });
      await applySettings(saved ?? (await getHomepageCustomSectionSettings()));
      toast.success("تنظیمات بخش ویژه ذخیره شد");
    } catch (error) {
      logger.error("[HomepageCustomSection] Failed to save", { error });
      toast.error("خطا در ذخیره تنظیمات");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <ContentWrapper title="بخش ویژه صفحه اصلی">
        <div className="p-4 text-neutral-600">در حال بارگذاری...</div>
      </ContentWrapper>
    );
  }

  return (
    <ContentWrapper title="بخش ویژه صفحه اصلی">
      <div className="space-y-6 p-4">
        <SectionEditor
          heading="بخش ویژه (پیش از تخفیف‌ها)"
          hint="این بخش پیش از «تخفیف‌های وسوسه انگیز» نمایش داده می‌شود. عنوان، محصولات و لینک «مشاهده همه» آن قابل تنظیم است."
          titlePlaceholder="مثال: پیشنهاد ویژه"
          categoryOptions={categoryOptions}
          section={sectionTwo}
          onEnabledChange={(enabled) =>
            setSectionTwo((current) => ({ ...current, enabled }))
          }
          onTitleChange={(title) => setSectionTwo((current) => ({ ...current, title }))}
          onViewAllHrefChange={(viewAllHref) =>
            setSectionTwo((current) => ({ ...current, viewAllHref }))
          }
          onAssignmentChange={(assignment) => setAssignment(setSectionTwo, assignment)}
          onSummaryAdded={(product) =>
            setSectionTwo((current) => ({
              ...current,
              summaries: [...current.summaries, product],
            }))
          }
        />

        <SectionEditor
          heading="بخش ویژه (پس از کمپین گیف)"
          hint="این بخش بین کمپین گیف و بنرهای صفحه اصلی نمایش داده می‌شود. عنوان، محصولات و لینک «مشاهده همه» آن قابل تنظیم است."
          titlePlaceholder="مثال: پیشنهاد هفته"
          categoryOptions={categoryOptions}
          section={sectionOne}
          onEnabledChange={(enabled) =>
            setSectionOne((current) => ({ ...current, enabled }))
          }
          onTitleChange={(title) => setSectionOne((current) => ({ ...current, title }))}
          onViewAllHrefChange={(viewAllHref) =>
            setSectionOne((current) => ({ ...current, viewAllHref }))
          }
          onAssignmentChange={(assignment) => setAssignment(setSectionOne, assignment)}
          onSummaryAdded={(product) =>
            setSectionOne((current) => ({
              ...current,
              summaries: [...current.summaries, product],
            }))
          }
        />

        <SectionEditor
          heading="بخش ویژه (پس از منتخب‌های این هفته)"
          hint="این بخش پس از «منتخب‌های این هفته» نمایش داده می‌شود. عنوان، محصولات و لینک «مشاهده همه» آن قابل تنظیم است."
          titlePlaceholder="مثال: پیشنهاد پایان هفته"
          categoryOptions={categoryOptions}
          section={sectionThree}
          onEnabledChange={(enabled) =>
            setSectionThree((current) => ({ ...current, enabled }))
          }
          onTitleChange={(title) => setSectionThree((current) => ({ ...current, title }))}
          onViewAllHrefChange={(viewAllHref) =>
            setSectionThree((current) => ({ ...current, viewAllHref }))
          }
          onAssignmentChange={(assignment) => setAssignment(setSectionThree, assignment)}
          onSummaryAdded={(product) =>
            setSectionThree((current) => ({
              ...current,
              summaries: [...current.summaries, product],
            }))
          }
        />

        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-xl bg-infinity-primary px-6 py-2.5 text-white transition hover:bg-infinity-primary-dark disabled:opacity-50"
          >
            {saving ? "در حال ذخیره..." : "ذخیره تغییرات"}
          </button>
        </div>
      </div>
    </ContentWrapper>
  );
}
