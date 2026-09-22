"use client";
import SetDetails from "@/components/Product/add/SetCategory/SetCategory";
import Overall from "@/components/Product/add/Overall";
import IndexPhotoUploader from "@/components/Product/add/IndexPhotoUploader";
import { useEffect, useState } from "react";
import { DatePicker, TimePicker } from "zaman";
import toast from "react-hot-toast";
import { useProductCategory } from "@/hooks/product/useCategory";
import { productDataAtom, resetProductDataAtom } from "@/atoms/super-admin/products";
import { useAtomValue, useSetAtom } from "jotai";
import { createProduct } from "@/services/super-admin/product/create";
import { useRouter } from "next/navigation";
import logger from "@/utils/logger";
import { useEditorRedirect } from "@/hooks/useEditorRedirect";
import { refreshTable } from "@/components/SuperAdmin/Table";
import { apiCache } from "@/lib/api-cache";
import {
  changeProductPublication,
  PRODUCT_PUBLICATION_TIMEZONE,
  type ProductPublicationAction,
} from "@/services/super-admin/product/publication";
import {
  instantToTehranWallTime,
  pickerToTehranIso,
  tehranPickerDate,
} from "@/utils/tehranPublicationTime";

// Define the type for the API response
interface ProductApiResponse {
  success: boolean;
  data?: {
    id: number;
    [key: string]: any;
  };
  error?: any;
}

export default function AddProductsPage() {
  const { fetchAllCategories } = useProductCategory();
  const productData = useAtomValue(productDataAtom);
  const resetProductData = useSetAtom(resetProductDataAtom);
  const router = useRouter();
  const setRefresh = useSetAtom(refreshTable);
  const defaultSchedule = new Date(Date.now() + 10 * 60_000);
  const defaultScheduleParts = instantToTehranWallTime(defaultSchedule);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState(() => tehranPickerDate(defaultSchedule));
  const [scheduleTime, setScheduleTime] = useState({
    hour: defaultScheduleParts.hour,
    minute: defaultScheduleParts.minute,
  });
  const [saving, setSaving] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  // Redirect editors away from product pages
  useEditorRedirect();
  if (process.env.NODE_ENV !== "production") {
    logger.info("productData", { productData });
  }
  useEffect(() => {
    resetProductData();
  }, [resetProductData]);

  useEffect(() => {
    // Only fetch categories once on mount to prevent multiple API calls
    fetchAllCategories();
  }, [fetchAllCategories]);

  useEffect(() => {
    if (productData.product_main_category) {
      setCategoryError(null);
    }
  }, [productData.product_main_category]);

  const handleCreateProduct = async (publicationAction?: ProductPublicationAction) => {
    if (saving) return;
    if (!productData.product_main_category) {
      setCategoryError("انتخاب دسته‌بندی اصلی الزامی است");
      toast.error("لطفاً دسته‌بندی اصلی محصول را انتخاب کنید");
      return;
    }
    setSaving(true);
    let createdProductId: number | null = null;
    try {
      const result = (await createProduct(productData)) as ProductApiResponse;
      if (result.success && result.data) {
        // Clear product-related cache entries to ensure fresh data
        // Do this immediately before redirect to ensure cache is cleared
        apiCache.clearByPattern(/\/api\/products/i);

        // Get the product ID from the response and redirect to its edit page
        const productId = result.data?.id;
        if (productId) {
          createdProductId = productId;
          if (publicationAction) {
            const publishAt =
              publicationAction === "schedule"
                ? pickerToTehranIso(scheduleDate, scheduleTime.hour, scheduleTime.minute)
                : undefined;
            if (publishAt && Date.parse(publishAt) <= Date.now()) {
              toast.error("زمان انتشار باید در آینده باشد");
              router.push(`/products/${productId}`);
              return;
            }
            await changeProductPublication(productId, {
              action: publicationAction,
              publishAt,
              timezone: publicationAction === "schedule" ? PRODUCT_PUBLICATION_TIMEZONE : undefined,
            });
          }
          // Trigger table refresh before redirecting
          setRefresh(true);
          router.push(`/products/${productId}`);
        } else {
          // Fallback to products list if ID is not available
          // Trigger table refresh before redirecting
          setRefresh(true);
          router.push("/products");
          // Force Next.js to refresh the page data
          router.refresh();
        }
      } else {
        // Fallback to products list if no data is available
        // Clear product-related cache entries
        apiCache.clearByPattern(/\/api\/products/i);
        // Trigger table refresh before redirecting
        setRefresh(true);
        router.push("/products");
        // Force Next.js to refresh the page data
        router.refresh();
      }
    } catch (error) {
      console.error("Error creating product:", error);
      toast.error("محصول به‌صورت پیش‌نویس ذخیره شد اما عملیات انتشار کامل نشد");
      if (createdProductId) {
        setRefresh(true);
        router.push(`/products/${createdProductId}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex w-full grid-cols-3 flex-col gap-4 pb-28 lg:grid">
      <div className="order-2 flex flex-col gap-4 lg:order-1">
        <IndexPhotoUploader />
        <SetDetails categoryError={categoryError} />
        {scheduleOpen ? (
          <section dir="rtl" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-900">زمان‌بندی انتشار</h3>
            <p className="text-xs text-slate-500">منطقه زمانی: تهران (Asia/Tehran)</p>
            <DatePicker
              defaultValue={scheduleDate}
              inputClass="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
              onChange={(payload: any) => {
                const next = payload?.value instanceof Date ? payload.value : new Date(payload);
                if (!Number.isNaN(next.getTime())) setScheduleDate(next);
              }}
              accentColor="#7c3aed"
            />
            <TimePicker
              defaultValue={new Date(2020, 0, 1, scheduleTime.hour, scheduleTime.minute)}
              clockTime={24}
              inputClass="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
              onChange={(value: { hour: number; minute: number }) => setScheduleTime(value)}
              accentColor="#7c3aed"
            />
          </section>
        ) : null}
      </div>

      <div className="order-1 col-span-2 h-fit flex-1 lg:order-2">
        <Overall key={"overall"} />
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-3 z-30 flex justify-center px-4 pb-[env(safe-area-inset-bottom)] md:bottom-4 md:justify-end">
        <div className="pointer-events-auto grid w-full max-w-2xl grid-cols-2 gap-2 rounded-3xl border border-slate-200 bg-white/85 px-4 py-2.5 shadow-lg backdrop-blur-lg md:ml-16 md:flex md:w-fit md:max-w-3xl md:items-center md:justify-end md:bg-white/10">
          <button
            className="w-full rounded-xl border-2 border-slate-300 bg-slate-300/40 px-5 py-2 text-sm text-slate-500 hover:bg-slate-300/80 hover:text-slate-800 md:w-fit"
            onClick={() => router.push("/products")}
            data-testid="admin-product-cancel"
          >
            بیخیال شدن
          </button>

          <button
            disabled={saving}
            onClick={() => void handleCreateProduct()}
            className="w-full rounded-xl border-2 border-infinity-primary-lighter/60 bg-infinity-primary/10 px-5 py-2 text-sm text-infinity-primary-darker hover:bg-infinity-primary/80 hover:text-white md:w-fit"
            data-testid="admin-product-save"
          >
            ذخیره پیش‌نویس
          </button>
          <button
            disabled={saving}
            onClick={() => void handleCreateProduct("publish-now")}
            className="w-full rounded-xl border-2 border-green-300 bg-green-500/10 px-5 py-2 text-sm text-green-700 hover:bg-green-600 hover:text-white disabled:opacity-50 md:w-fit"
          >
            ذخیره و انتشار
          </button>
          <button
            disabled={saving}
            onClick={() => {
              if (!scheduleOpen) setScheduleOpen(true);
              else void handleCreateProduct("schedule");
            }}
            className="w-full rounded-xl border-2 border-blue-300 bg-blue-500/10 px-5 py-2 text-sm text-blue-700 hover:bg-blue-600 hover:text-white disabled:opacity-50 md:w-fit"
          >
            {scheduleOpen ? "ذخیره و زمان‌بندی" : "زمان‌بندی انتشار"}
          </button>
        </div>
      </div>
    </div>
  );
}
