"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import toast from "react-hot-toast";
import { productReviewService, ProductReview } from "@/services/product/product-review.service";
import type { ProductDetail } from "@/services/product/product";
import Modal from "@/components/Kits/Modal";
import PDPCommentAdd from "./Add";
import PDPCommentList, { type SortOption } from "./List";

type Props = {
  rating: number;
  rateCount: number;
  productReviews: ProductReview[];
  productId?: string;
  productData?: ProductDetail;
  initialTotalPages?: number;
};

export default function PDPComment(props: Props) {
  const { rating, rateCount, productReviews: initialReviews, productId, productData, initialTotalPages = 1 } = props;
  const [reviews, setReviews] = useState<ProductReview[]>(initialReviews);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortOption, setSortOption] = useState<SortOption>("newest");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const requestGeneration = useRef(0);
  useEffect(() => {
    requestGeneration.current += 1;
    setReviews(initialReviews);
    setPage(1);
    setTotalPages(initialTotalPages);
    setSortOption("newest");
    setLoadingReviews(false);
    return () => { requestGeneration.current += 1; };
  }, [productId, initialReviews, initialTotalPages]);
  const canRenderModal = typeof document !== "undefined";

  const loadReviews = useCallback(async (nextPage: number, sort: SortOption) => {
    if (!productId) return;
    const generation = ++requestGeneration.current;
    setLoadingReviews(true);
    try {
      const order = { newest: "createdAt:desc", oldest: "createdAt:asc", highestRating: "Rate:desc", lowestRating: "Rate:asc" };
      const response = await productReviewService.getProductReviews(productId, { page: nextPage, sort: order[sort] });
      if (generation !== requestGeneration.current) return;
      setReviews(current => nextPage === 1 ? response.data : [...current, ...response.data.filter(item => !current.some(review => review.id === item.id))]);
      setPage(nextPage);
      setTotalPages(response.meta?.totalPages || 1);
      setSortOption(sort);
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      console.error("Error fetching reviews:", error);
      toast.error("خطا در دریافت دیدگاه‌ها. لطفاً دوباره تلاش کنید.");
    } finally {
      if (generation === requestGeneration.current) setLoadingReviews(false);
    }
  }, [productId]);
  const fetchReviews = useCallback(() => loadReviews(1, sortOption), [loadReviews, sortOption]);

  const handleStatusUpdate = async (id: number, status: "Accepted" | "Rejected") => {
    try {
      await productReviewService.updateStatus(id, status);
      toast.success(status === "Accepted" ? "دیدگاه تأیید شد" : "دیدگاه رد شد");
      await fetchReviews();
    } catch (_error) {
      toast.error("خطا در تغییر وضعیت دیدگاه");
    }
  };

  const handleDelete = async (id: number): Promise<boolean> => {
    try {
      setIsDeleting(true);
      await productReviewService.deleteReview(id);
      toast.success("دیدگاه حذف شد");
      await fetchReviews();
      return true;
    } catch (_error) {
      toast.error("خطا در حذف دیدگاه");
      return false;
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteRequest = (id: number) => {
    if (!canRenderModal) return;
    setPendingDeleteId(id);
    setIsConfirmOpen(true);
  };

  const handleDeleteCancel = () => {
    if (isDeleting) return;
    setIsConfirmOpen(false);
    setPendingDeleteId(null);
  };

  const handleDeleteConfirm = async () => {
    if (pendingDeleteId === null) return;
    const isDeleted = await handleDelete(pendingDeleteId);
    if (isDeleted) {
      setIsConfirmOpen(false);
      setPendingDeleteId(null);
    }
  };

  return (
    <div
      className="flex flex-col-reverse gap-4 md:flex-row"
      data-comments-section
      dir="rtl"
      style={{ scrollMarginTop: "var(--header-offset, 88px)" }}
    >
      <div className="flex-1">
        <PDPCommentList
          reviews={reviews}
          sortOption={sortOption}
          onSortChange={sort => { void loadReviews(1, sort); }}
          loading={loadingReviews}
          onStatusUpdate={handleStatusUpdate}
          onDelete={handleDeleteRequest}
        />
        {page < totalPages && (
          <button type="button" disabled={loadingReviews} onClick={() => { void loadReviews(page + 1, sortOption); }}
            className="mt-4 min-h-11 w-full rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 disabled:opacity-50">
            {loadingReviews ? "در حال دریافت…" : "دیدگاه‌های بیشتر"}
          </button>
        )}
      </div>

      <div className="flex flex-col-reverse gap-4 md:w-[386px] md:flex-col">
        <PDPCommentAdd
          rating={rating}
          rateCount={rateCount}
          productReviews={reviews}
          productId={productId}
          productData={productData}
          onReviewSubmitted={fetchReviews}
        />
      </div>

      {canRenderModal && (
        <Modal
          isOpen={isConfirmOpen}
          onClose={handleDeleteCancel}
          title="حذف دیدگاه"
          className="max-w-md"
        >
          <div className="space-y-4 text-sm text-neutral-700">
            <p>آیا از حذف این دیدگاه اطمینان دارید؟</p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleDeleteCancel}
                disabled={isDeleting}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                انصراف
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
                className="rounded-lg bg-red-500 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isDeleting ? "در حال حذف..." : "حذف"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
