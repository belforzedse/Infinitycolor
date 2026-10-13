"use client";
import {
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import SetDetails from "@/components/Product/add/SetCategory/SetCategory";
import Tabs from "@/components/Kits/Tabs";
import type { TabItem } from "@/types/Tabs";
import Overall from "@/components/Product/add/Overall";
import IndexPhotoUploader from "@/components/Product/add/IndexPhotoUploader";
import Variables from "@/components/Product/add/Variables";
import Sizes, {
  SizeGuideHandle,
  type SizeGuideDraft,
  sizeGuideDraftPayload,
} from "@/components/Product/add/Size";
import PublishAllVariations from "@/components/Product/add/PublishAllVariations";
import { apiClient } from "@/services";
import {
  editProductDataAtom,
  resetEditProductDataAtom,
} from "@/atoms/super-admin/products";
import { useAtom, useSetAtom } from "jotai";
import { transformToProductData } from "@/utils/populatedProductData";
import { updateProduct } from "@/services/super-admin/product/update";
import { duplicateProduct } from "@/services/super-admin/product/duplicate";
import { useRouter } from "next/navigation";
import { useProductCategory } from "@/hooks/product/useCategory";
import { useProductTag } from "@/hooks/product/useTag";
import { useCan } from "@/hooks/useCan";
import toast from "react-hot-toast";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import ProductActivityLogs from "@/components/SuperAdmin/Activity/ProductActivityLogs";
import ProductDisplayDateCard from "@/components/SuperAdmin/Product/ProductDisplayDateCard";
import ProductPublicationCard from "@/components/SuperAdmin/Product/ProductPublicationCard";
import ProductHomepageSectionsCard from "@/components/SuperAdmin/Product/ProductHomepageSectionsCard";
import { ProductEditorContext } from "@/hooks/product/ProductEditorContext";
import {
  ProductEditorSession,
  type ProductEditSnapshot,
  type ProductEditLeaseStatus,
  type ProductEditorState,
} from "@/services/super-admin/product/editor-session";
import ProductEditorFields from "@/components/Product/add/ProductEditorFields";
import Modal from "@/components/Kits/Modal";
import type { ProductPublicationAction } from "@/services/super-admin/product/publication";

const loadingEditorState: ProductEditorState = {
  phase: "loading",
  status: null,
  busy: false,
  snapshotEpoch: 0,
};
const noSubscribe = () => () => undefined;
const getLoadingState = () => loadingEditorState;

export default function EditProductsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <ProductEditorPage key={id} id={id} />;
}

function ProductEditorPage({ id }: { id: string }) {
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
  const canManageHomepage = useCan("product.homepage.manage");
  const { fetchAllCategories } = useProductCategory();
  const { handleFetchTags } = useProductTag();
  const [editor, setEditor] = useState<ProductEditorSession | null>(null);
  const editorState = useSyncExternalStore(
    editor?.subscribe ?? noSubscribe,
    editor?.getState ?? getLoadingState,
    getLoadingState,
  );
  const editing = editorState.phase === "editing";
  const [leaseConfirmation, setLeaseConfirmation] =
    useState<ProductEditLeaseStatus | null>(null);
  const initialLeasePrompted = useRef(false);
  const [showReloadConfirm, setShowReloadConfirm] = useState(false);
  const baseProductRef = useRef<ReturnType<
    typeof transformToProductData
  > | null>(null);
  const sizeGuideRef = useRef<SizeGuideHandle | null>(null);
  // Snapshot of the product as last loaded/saved, used to detect unsaved edits (H3).
  const savedSnapshotRef = useRef<string | null>(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showDuplicateConfirm, setShowDuplicateConfirm] = useState(false);
  // Raw LastEditedByAdminAt used to seed the display-date picker (admin reorder control).
  const [displayDate, setDisplayDate] = useState<string | null>(null);
  const [variationsRefreshKey, setVariationsRefreshKey] = useState(0);
  // Bumped when the variations tab adds, removes or re-colours variations, so the
  // published/total count on the side card does not go stale.
  const [publishCardRefreshKey, setPublishCardRefreshKey] = useState(0);
  const handleVariationsChanged = useCallback(
    () => setPublishCardRefreshKey((key) => key + 1),
    [],
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  // `editProductDataAtom` is module-level and shared by every product page, so nothing
  // may act on it until this product's own fetch has landed — otherwise a save writes
  // the previously opened product (or an empty form) over this one. Tracking the id
  // that was loaded (rather than a boolean flipped in an effect) makes this false on
  // the very first render after `id` changes, before any effect has run.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const loaded = loadedId === id;

  const isDirty = () => {
    if (
      savedSnapshotRef.current !== null &&
      JSON.stringify(productData) !== savedSnapshotRef.current
    )
      return true;
    for (const [key, value] of editor?.drafts ?? []) {
      if ((value as { dirty?: boolean })?.dirty) return true;
      if (key === "size-guide") {
        try {
          if (sizeGuideDraftPayload(value as SizeGuideDraft)) return true;
        } catch {
          return true;
        }
      }
    }
    return false;
  };

  const installSnapshot = useCallback(
    (snapshot: ProductEditSnapshot) => {
      const fresh = transformToProductData(snapshot.product.attributes);
      setProductData(fresh);
      baseProductRef.current = fresh;
      savedSnapshotRef.current = JSON.stringify(fresh);
      setDisplayDate(snapshot.product.attributes.LastEditedByAdminAt ?? null);
      setLoadedId(id);
    },
    [id, setProductData],
  );

  const mayEdit =
    canUpdate ||
    canPublish ||
    canSchedule ||
    canManageVariations ||
    canManageSizeGuide ||
    canManageHomepage;
  useEffect(() => {
    resetProductData();
    savedSnapshotRef.current = null;
    const session = new ProductEditorSession(id, installSnapshot);
    setEditor(session);
    void session.open(mayEdit);
    return () => session.dispose();
  }, [id, installSnapshot, mayEdit, resetProductData]);

  const captureLeaseConfirmation = useCallback(
    (status: ProductEditLeaseStatus | null) => {
      if (!status?.owner) return;
      initialLeasePrompted.current = true;
      setLeaseConfirmation({ ...status, owner: { ...status.owner } });
    },
    [],
  );
  useEffect(() => {
    if (
      !initialLeasePrompted.current &&
      editorState.phase === "readonly" &&
      editorState.status?.owner &&
      mayEdit
    ) {
      captureLeaseConfirmation(editorState.status);
    }
  }, [
    captureLeaseConfirmation,
    editorState.phase,
    editorState.status,
    mayEdit,
  ]);

  const confirmTakeover = async () => {
    const confirmation = leaseConfirmation;
    if (!editor || !confirmation?.owner) return;
    setLeaseConfirmation(null);
    const result = await editor.acquire(true, confirmation.generation);
    if (result.outcome === "conflict" && result.status?.owner)
      captureLeaseConfirmation(result.status);
  };

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            product: productData,
            drafts: Object.fromEntries(editor?.drafts ?? []),
          },
          null,
          2,
        ),
      );
      toast.success("تغییرات کپی شد");
    } catch {
      toast.error("کپی تغییرات انجام نشد");
    }
  };

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
    const releaseOnPageHide = () => {
      void editor?.release();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", releaseOnPageHide);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", releaseOnPageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productData, editor]);

  const handleUpdateProduct = async (): Promise<boolean> => {
    if (!loaded || !editing || !editor || !baseProductRef.current) return false;
    const loadingToast = toast.loading("در حال ذخیره...");
    try {
      const sizeGuide = canManageSizeGuide
        ? sizeGuideDraftPayload(
            editor.drafts.get("size-guide") as SizeGuideDraft | undefined,
          )
        : undefined;
      const result = await updateProduct(
        id,
        productData,
        baseProductRef.current,
        editor.client,
        sizeGuide,
      );
      installSnapshot(result.data);
      if (sizeGuide) {
        const helper = result.data.product.attributes.product_size_helper?.data;
        editor.drafts.delete("size-guide");
        sizeGuideRef.current?.acceptSaved(helper);
      }
      toast.success("محصول ذخیره شد");
      return true;
    } catch {
      toast.error("محصول ذخیره نشد");
      return false;
    } finally {
      toast.dismiss(loadingToast);
    }
  };

  const handleBeforePublication = async (_action: ProductPublicationAction) => {
    if (!loaded) return false;
    if (!isDirty()) return true;
    return handleUpdateProduct();
  };

  const handlePublicationChanged = async () => {
    const refreshed = await apiClient.get<ProductEditSnapshot>(
      `/products/${id}/edit-snapshot`,
      { cache: "no-store", retries: 0 },
    );
    // Publication changes only these fields; preserve any unsaved title/media draft.
    const attrs = refreshed.data.product.attributes;
    setProductData((draft) => ({
      ...draft,
      Status: attrs.Status as typeof draft.Status,
      scheduledPublishAt: attrs.scheduledPublishAt,
      scheduledPublishLastError: attrs.scheduledPublishLastError,
      scheduledPublishFailureKind: attrs.scheduledPublishFailureKind,
    }));
    if (baseProductRef.current) {
      baseProductRef.current = {
        ...baseProductRef.current,
        Status: attrs.Status as typeof productData.Status,
        scheduledPublishAt: attrs.scheduledPublishAt,
        scheduledPublishLastError: attrs.scheduledPublishLastError,
        scheduledPublishFailureKind: attrs.scheduledPublishFailureKind,
      };
      savedSnapshotRef.current = JSON.stringify(baseProductRef.current);
    }
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
    void editor?.release();
    router.push("/products");
  };

  const confirmLeave = () => {
    setShowLeaveConfirm(false);
    void editor?.release();
    router.push("/products");
  };

  const isSimpleProduct = productData.ProductType === "Simple";

  const handlePreview = async () => {
    if (!loaded || previewLoading) return;
    setPreviewLoading(true);

    try {
      const overlay: Record<string, unknown> = {
        Title: productData.Title,
        Description: productData.Description,
        Status: productData.Status,
        coverImageId: productData.CoverImage?.data?.id ?? null,
        mediaIds: productData.Media.map((item) => item.id),
        fileIds: productData.Files.map((item) => item.id),
        mainCategoryId: productData.product_main_category?.id ?? null,
        otherCategoryIds: productData.product_other_categories.map(
          (category) => category.id,
        ),
        tagIds: productData.product_tags.map((tag) => tag.id),
      };

      if (isSimpleProduct && productData.SimpleVariationId) {
        overlay.simpleVariationId = productData.SimpleVariationId;
        overlay.simplePrice = productData.SimplePrice;
        overlay.simpleDiscountPrice = productData.SimpleDiscountPrice ?? null;
        overlay.simpleStock = productData.SimpleStock;
      }

      const response = await apiClient.post(`/products/${id}/preview-draft`, {
        data: overlay,
      });
      // Admin and storefront are separate origins with no rewrite between them
      // (see api/product/controllers/product.ts createPreviewDraft), so the
      // backend — not window.location.origin — decides the storefront URL.
      const url = (response.data as { url?: string })?.url;
      if (!url) throw new Error("Preview URL missing from response");

      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      console.error("Error creating product preview:", error);
      toast.error("خطا در ایجاد پیش‌نمایش محصول");
    } finally {
      setPreviewLoading(false);
    }
  };

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
    ...(canManageSizeGuide ? [{ key: "3", value: "راهنمای سایز" }] : []),
  ];

  return (
    <ProductEditorContext.Provider value={editor}>
      <div className="flex w-full grid-cols-3 flex-col gap-4 pb-32 lg:grid">
        <div
          className="col-span-3 flex flex-wrap items-center gap-3 rounded-xl bg-white p-4"
          role="status"
          data-testid="product-editor-status"
        >
          <span>
            {editorState.phase === "loading"
              ? "در حال دریافت محصول..."
              : editing
                ? "ویرایش در اختیار شماست"
                : editorState.phase === "frozen"
                  ? editorState.reason
                  : "حالت فقط مشاهده"}
          </span>
          {editorState.phase === "readonly" && mayEdit && (
            <button
              disabled={editorState.busy}
              onClick={() =>
                editorState.status?.owner
                  ? captureLeaseConfirmation(editorState.status)
                  : void editor?.acquire()
              }
              className="rounded-lg border px-3 py-2"
            >
              شروع ویرایش
            </button>
          )}
          {editorState.phase === "frozen" && (
            <>
              <button
                onClick={() => void copyDraft()}
                className="rounded-lg border px-3 py-2"
              >
                کپی تغییرات
              </button>
              <button
                onClick={() => setShowReloadConfirm(true)}
                className="rounded-lg border px-3 py-2"
              >
                بارگذاری دوباره
              </button>
            </>
          )}
        </div>
        <Modal
          isOpen={leaseConfirmation !== null}
          onClose={() => setLeaseConfirmation(null)}
          title="این محصول در حال ویرایش است"
          className="max-w-lg"
        >
          <p className="mb-4 text-sm">
            {leaseConfirmation?.owner?.label || "کاربر دیگری"} در حال ویرایش این
            محصول است. با گرفتن ویرایش، ادامه ویرایش برای او متوقف می‌شود.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setLeaseConfirmation(null)}
              className="rounded-lg border px-3 py-2"
            >
              مشاهده بدون ویرایش
            </button>
            <button
              onClick={handleCancel}
              className="rounded-lg border px-3 py-2"
            >
              انصراف
            </button>
            <button
              disabled={editorState.busy}
              onClick={() => void confirmTakeover()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-white"
            >
              گرفتن دسترسی ویرایش
            </button>
          </div>
        </Modal>
        <ConfirmDialog
          isOpen={showReloadConfirm}
          title="بارگذاری دوباره محصول"
          description="تغییرات ذخیره‌نشده این صفحه جایگزین می‌شود. پیش از ادامه می‌توانید آن‌ها را کپی کنید."
          confirmText="بارگذاری دوباره"
          cancelText="ماندن در صفحه"
          onConfirm={() => window.location.reload()}
          onCancel={() => setShowReloadConfirm(false)}
        />
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
          <ProductEditorFields disabled={!loaded || !canUpdate}>
            <IndexPhotoUploader
              isEditMode
              disabled={!loaded || !editing || !canUpdate}
            />
          </ProductEditorFields>
          {loaded && (canPublish || canSchedule) && (
            <ProductEditorFields>
              <ProductPublicationCard
                key={editorState.snapshotEpoch}
                productId={id}
                status={productData.Status}
                scheduledPublishAt={productData.scheduledPublishAt}
                scheduledPublishLastError={
                  productData.scheduledPublishLastError
                }
                scheduledPublishFailureKind={
                  productData.scheduledPublishFailureKind
                }
                canPublish={canPublish}
                canSchedule={canSchedule}
                beforeAction={handleBeforePublication}
                onChanged={handlePublicationChanged}
              />
            </ProductEditorFields>
          )}
          {loaded && !isSimpleProduct && canManageVariations && (
            <ProductEditorFields>
              <PublishAllVariations
                key={editorState.snapshotEpoch}
                productId={Number(id)}
                refreshKey={variationsRefreshKey + publishCardRefreshKey}
              />
            </ProductEditorFields>
          )}
          {/* <SetPrice />
        <SetStatus /> */}
          <ProductEditorFields disabled={!loaded || !canUpdate}>
            <SetDetails isEditMode />
          </ProductEditorFields>
          {loaded && canSchedule && (
            <ProductEditorFields>
              <ProductDisplayDateCard
                key={editorState.snapshotEpoch}
                productId={id}
                initialDate={displayDate}
              />
            </ProductEditorFields>
          )}
          {loaded && canManageHomepage && (
            <ProductEditorFields>
              <ProductHomepageSectionsCard
                key={editorState.snapshotEpoch}
                productId={Number(id)}
              />
            </ProductEditorFields>
          )}
          {canReadAudit && (
            <ProductActivityLogs
              productId={id}
              pageSize={20}
              title="رویدادهای محصول"
            />
          )}
        </div>
        <div className="order-1 col-span-2 h-fit flex-1 lg:order-2">
          {loaded && (
            <Tabs
              key={editorState.snapshotEpoch}
              tabs={tabs}
              tabsClassName="!bg-transparent"
            >
              {[
                <ProductEditorFields
                  key="overall"
                  disabled={!loaded || !canUpdate}
                >
                  <Overall productData={productData} isEditMode />
                </ProductEditorFields>,
                ...(!isSimpleProduct
                  ? [
                      <ProductEditorFields
                        key="variables"
                        disabled={!loaded || !canManageVariations}
                      >
                        <Variables
                          productId={Number(id)}
                          refreshKey={variationsRefreshKey}
                          onVariationsChanged={handleVariationsChanged}
                        />
                      </ProductEditorFields>,
                    ]
                  : []),
                ...(canManageSizeGuide
                  ? [
                      <Sizes
                        key={"sizes"}
                        ref={sizeGuideRef}
                        productId={Number(id)}
                      />,
                    ]
                  : []),
              ]}
            </Tabs>
          )}
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
            <button
              disabled={!loaded || previewLoading}
              onClick={() => void handlePreview()}
              className="w-full rounded-xl border-2 border-slate-200 bg-slate-500/10 px-3 py-2 text-sm text-slate-600 hover:bg-slate-500/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 md:w-fit md:px-5"
              data-testid="admin-product-preview"
            >
              {previewLoading ? "در حال آماده‌سازی..." : "پیش‌نمایش"}
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
                disabled={!loaded || !editing || editorState.busy}
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
    </ProductEditorContext.Provider>
  );
}
