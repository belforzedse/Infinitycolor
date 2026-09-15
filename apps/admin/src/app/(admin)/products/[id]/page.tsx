"use client";
import { use, useEffect, useMemo, useRef, useState } from "react";
import SetDetails from "@/components/Product/add/SetCategory/SetCategory";
import Tabs from "@/components/Kits/Tabs";
import type { TabItem } from "@/types/Tabs";
import Overall from "@/components/Product/add/Overall";
import IndexPhotoUploader from "@/components/Product/add/IndexPhotoUploader";
import Variables from "@/components/Product/add/Variables";
import Sizes, { SizeGuideHandle } from "@/components/Product/add/Size";
import PublishAllVariations from "@/components/Product/add/PublishAllVariations";
import { getProduct } from "@/services/super-admin/product/get";
import { editProductDataAtom, resetEditProductDataAtom } from "@/atoms/super-admin/products";
import { useAtom, useSetAtom } from "jotai";
import { transformToProductData } from "@/utils/populatedProductData";
import { updateProduct } from "@/services/super-admin/product/update";
import { duplicateProduct } from "@/services/super-admin/product/duplicate";
import { useRouter } from "next/navigation";
import { useProductCategory } from "@/hooks/product/useCategory";
import { useProductTag } from "@/hooks/product/useTag";
import logger from "@/utils/logger";
import { useCan } from "@/hooks/useCan";
import toast from "react-hot-toast";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import ProductActivityLogs from "@/components/SuperAdmin/Activity/ProductActivityLogs";
import ProductDisplayDateCard from "@/components/SuperAdmin/Product/ProductDisplayDateCard";
import ProductPublicationCard from "@/components/SuperAdmin/Product/ProductPublicationCard";
import type { ProductPublicationAction } from "@/services/super-admin/product/publication";

export default function EditProductsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const { id } = resolvedParams;
  const [productData, setProductData] = useAtom(editProductDataAtom);
  const resetProductData = useSetAtom(resetEditProductDataAtom);
  const router = useRouter();
  const canUpdate = useCan("product.update");
  const canDuplicate = useCan("product.duplicate");
  const canPublish = useCan("product.publish");
  const canSchedule = useCan("product.schedule");
  const canManageVariations = useCan("product.variation.manage");
  const canManageSizeGuide = useCan("product.size-guide.manage");
  const canReadAudit = useCan("system.audit.read");
  const { fetchAllCategories } = useProductCategory();
  const { handleFetchTags } = useProductTag();
  const sizeGuideRef = useRef<SizeGuideHandle | null>(null);
  // Snapshot of the product as last loaded/saved, used to detect unsaved edits (H3).
  const savedSnapshotRef = useRef<string | null>(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showDuplicateConfirm, setShowDuplicateConfirm] = useState(false);
  // Raw LastEditedByAdminAt used to seed the display-date picker (admin reorder control).
  const [displayDate, setDisplayDate] = useState<string | null>(null);
  const [variationsRefreshKey, setVariationsRefreshKey] = useState(0);
  // `editProductDataAtom` is module-level and shared by every product page, so nothing
  // may act on it until this product's own fetch has landed — otherwise a save writes
  // the previously opened product (or an empty form) over this one. Tracking the id
  // that was loaded (rather than a boolean flipped in an effect) makes this false on
  // the very first render after `id` changes, before any effect has run.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const loaded = loadedId === id;

  const isDirty = () =>
    savedSnapshotRef.current !== null && JSON.stringify(productData) !== savedSnapshotRef.current;

  const getProductParams = useMemo(
    () => ({
      Files: true,
      Media: true,
      CoverImage: true,
      product_main_category: true,
      product_tags: true,
      // Deep-populate variations so simple-product fields (stock + attribute-less
      // detection) can be reconstructed for the edit form.
      product_variations: {
        product_stock: true,
        product_variation_color: true,
        product_variation_size: true,
        product_variation_model: true,
      },
      product_other_categories: true,
    }),
    [],
  );

  useEffect(() => {
    let cancelled = false;

    // Clear the shared atom before awaiting anything: until this product's data lands,
    // the form must not render (or save) whichever product was open before.
    resetProductData();
    savedSnapshotRef.current = null;
    setDisplayDate(null);

    const fetchProduct = async () => {
      try {
        // Force fresh data fetch - no cache
        const result = await getProduct(id, getProductParams);
        if (cancelled) return;
        const loadedProduct = transformToProductData(result.data.attributes);
        setProductData(loadedProduct);
        setDisplayDate(
          (result.data.attributes as { LastEditedByAdminAt?: string | null }).LastEditedByAdminAt ??
            null,
        );
        savedSnapshotRef.current = JSON.stringify(loadedProduct);
        setLoadedId(id);
      } catch (error: any) {
        if (cancelled) return;
        if (process.env.NODE_ENV !== "production") {
          logger.error("error in fetching product", { error });
        }
        // Leave `loadedId` behind: an empty form must never be savable over a real product.
        toast.error("خطا در دریافت اطلاعات محصول");
      }
    };

    fetchProduct();

    return () => {
      cancelled = true;
    };
  }, [id, setProductData, resetProductData, getProductParams]);

  useEffect(() => {
    // Only fetch categories and tags once on mount to prevent infinite loops
    fetchAllCategories();
    handleFetchTags();
  }, [fetchAllCategories, handleFetchTags]);

  // Warn before a full page unload (refresh/close/external nav) when there are
  // unsaved edits. In-app navigation via the Cancel button is guarded separately.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productData]);

  const handleUpdateProduct = async (): Promise<boolean> => {
    if (!loaded) return false;
    const loadingToast = toast.loading("در حال ذخیره...");

    try {
      if (process.env.NODE_ENV !== "production") {
        logger.info("productData2", { productData });
      }

    const sizeSaveResult = canManageSizeGuide
      ? await sizeGuideRef.current?.save?.()
      : undefined;
      if (sizeSaveResult === false) {
        toast.dismiss(loadingToast);
        toast.error("خطا در ذخیره راهنمای سایز");
        return false;
      }

      const result = await updateProduct(id, productData);

      if (result.success) {
        // Refresh product data to reflect changes (especially for image deletion)
        try {
          const refreshedResult = await getProduct(id, getProductParams);
          const refreshed = transformToProductData(refreshedResult.data.attributes);
          setProductData(refreshed);
          savedSnapshotRef.current = JSON.stringify(refreshed);
          toast.dismiss(loadingToast);
          toast.success("محصول با موفقیت ذخیره شد");
        } catch (refreshError) {
          // Even if refresh fails, the update was successful — treat the current
          // in-memory state as saved so we don't show a false unsaved-changes warning.
          savedSnapshotRef.current = JSON.stringify(productData);
          toast.dismiss(loadingToast);
          toast.success("محصول با موفقیت ذخیره شد");
          console.error("Error refreshing product data:", refreshError);
        }
        return true;
      } else {
        // Show error toast with the error message
        toast.dismiss(loadingToast);
        const errorMessage = result.errorMessage || "خطا در ذخیره محصول";
        toast.error(errorMessage);
        return false;
      }
    } catch (error) {
      toast.dismiss(loadingToast);
      toast.error("خطا در ذخیره محصول");
      console.error("Error updating product:", error);
      return false;
    }
  };

  const handleBeforePublication = async (_action: ProductPublicationAction) => {
    if (!loaded) return false;
    if (!isDirty()) return true;
    return handleUpdateProduct();
  };

  const handlePublicationChanged = async () => {
    const refreshedResult = await getProduct(id, getProductParams);
    const refreshed = transformToProductData(refreshedResult.data.attributes);
    setProductData(refreshed);
    savedSnapshotRef.current = JSON.stringify(refreshed);
    // Publishing the product also publishes its variations server-side.
    setVariationsRefreshKey((key) => key + 1);
  };

  const handleDuplicateProduct = async () => {
    setShowDuplicateConfirm(false);
    try {
      const result = await duplicateProduct(id);
      if (result.success && result.newProductId) {
        router.push(`/products/${result.newProductId}`);
      }
    } catch (error) {
      console.error("Error duplicating product:", error);
    }
  };

  const handleCancel = () => {
    if (isDirty()) {
      setShowLeaveConfirm(true);
      return;
    }
    router.push("/products");
  };

  const confirmLeave = () => {
    setShowLeaveConfirm(false);
    router.push("/products");
  };

  const isSimpleProduct = productData.ProductType === "Simple";

  const tabs: TabItem[] = [
    {
      key: "1",
      value: "کلی",
    },
    ...(!isSimpleProduct
      ? [
          {
            key: "2",
            value: "متغیرها",
          },
        ]
      : []),
    ...(canManageSizeGuide
      ? [{ key: "3", value: "راهنمای سایز" }]
      : []),
  ];

  return (
    <div className="flex w-full grid-cols-3 flex-col gap-4 pb-32 lg:grid">
      <ConfirmDialog
        isOpen={showLeaveConfirm}
        title="تغییرات ذخیره‌نشده"
        description="تغییراتی که ذخیره نکرده‌اید از بین می‌رود. آیا می‌خواهید بدون ذخیره خارج شوید؟"
        confirmText="خروج بدون ذخیره"
        cancelText="ماندن در صفحه"
        onConfirm={confirmLeave}
        onCancel={() => setShowLeaveConfirm(false)}
      />
      <ConfirmDialog
        isOpen={showDuplicateConfirm}
        title="کپی محصول"
        description="یک نسخه جدید از این محصول ساخته می‌شود و به صفحه آن منتقل می‌شوید. ادامه می‌دهید؟"
        confirmText="بله، کپی کن"
        cancelText="انصراف"
        onConfirm={handleDuplicateProduct}
        onCancel={() => setShowDuplicateConfirm(false)}
      />
      <div className="order-2 flex flex-col gap-4 lg:order-1">
        <IndexPhotoUploader isEditMode disabled={!loaded} />
        {loaded && (canPublish || canSchedule) && (
          <ProductPublicationCard
            productId={id}
            status={productData.Status}
            scheduledPublishAt={productData.scheduledPublishAt}
            scheduledPublishLastError={productData.scheduledPublishLastError}
            scheduledPublishFailureKind={productData.scheduledPublishFailureKind}
            canPublish={canPublish}
            canSchedule={canSchedule}
            beforeAction={handleBeforePublication}
            onChanged={handlePublicationChanged}
          />
        )}
        {!isSimpleProduct && canManageVariations && (
          <PublishAllVariations productId={Number(id)} refreshKey={variationsRefreshKey} />
        )}
        {/* <SetPrice />
        <SetStatus /> */}
        <SetDetails isEditMode />
        {canSchedule && <ProductDisplayDateCard productId={id} initialDate={displayDate} />}
        {canReadAudit && (
          <ProductActivityLogs productId={id} pageSize={20} title="رویدادهای محصول" />
        )}
      </div>
      <div className="order-1 col-span-2 h-fit flex-1 lg:order-2">
        <Tabs tabs={tabs} tabsClassName="!bg-transparent">
          {[
            <Overall key={"overall"} productData={productData} isEditMode />,
            ...(!isSimpleProduct ? [
                  <Variables
                    key={"variables"}
                    productId={Number(id)}
                    refreshKey={variationsRefreshKey}
                  />,
                ] : []),
            ...(canManageSizeGuide
              ? [<Sizes key={"sizes"} ref={sizeGuideRef} productId={Number(id)} />]
              : []),
          ]}
        </Tabs>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-3 z-30 flex justify-center px-4 pb-[env(safe-area-inset-bottom)] md:bottom-4 md:justify-end">
        <div className="pointer-events-auto grid w-full max-w-lg grid-cols-3 gap-2 rounded-3xl border border-slate-200 bg-white/85 px-4 py-2.5 shadow-lg backdrop-blur-lg md:ml-16 md:flex md:w-fit md:max-w-2xl md:items-center md:justify-end md:bg-white/10">
          <button
            className="w-full rounded-xl border-2 border-slate-300 bg-slate-300/40 px-3 py-2 text-sm text-slate-500 hover:bg-slate-300/80 hover:text-slate-800 md:w-fit md:px-5"
            onClick={handleCancel}
            data-testid="admin-product-cancel"
          >
            بیخیال شدن
          </button>
          {canDuplicate && (
            <button
              disabled={!loaded}
              onClick={() => setShowDuplicateConfirm(true)}
              className="w-full rounded-xl border-2 border-blue-200 bg-blue-500/10 px-3 py-2 text-sm text-blue-500 hover:bg-blue-500/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 md:w-fit md:px-5"
              data-testid="admin-product-detail-duplicate"
            >
              کپی محصول
            </button>
          )}
          {canUpdate && (
            <button
              disabled={!loaded}
              onClick={() => void handleUpdateProduct()}
              className="w-full rounded-xl border-2 border-infinity-primary-lighter/60 bg-infinity-primary/10 px-3 py-2 text-sm text-infinity-primary-darker hover:bg-infinity-primary/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 md:w-fit md:px-5"
              data-testid="admin-product-save"
            >
              ذخیره تغییرات
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
