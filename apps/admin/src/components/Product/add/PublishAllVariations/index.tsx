"use client";

import React, { useState, useEffect } from "react";
import { useProductEditor } from "@/hooks/product/ProductEditorContext";
import toast from "react-hot-toast";
import EditIcon from "@/components/User/Icons/EditIcon";

interface PublishAllVariationsProps {
  productId: number;
  /** Bumped by the parent after a product publish cascades to the variations. */
  refreshKey?: number;
}

interface Variation {
  id: number;
  attributes: {
    IsPublished: boolean;
  };
}

export default function PublishAllVariations({
  productId,
  refreshKey = 0,
}: PublishAllVariationsProps) {
  const { client: apiClient, canEdit } = useProductEditor();
  const [isLoading, setIsLoading] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [variations, setVariations] = useState<Variation[]>([]);

  // Calculate publication status using the same logic as the table
  const totalCount = variations.length;
  const publishedCount = variations.filter((v) => v?.attributes?.IsPublished === true).length;

  const getPublicationStatus = () => {
    if (totalCount === 0) {
      return {
        text: "بدون تنوع",
        className: "bg-gray-100 text-gray-700",
      };
    }

    if (publishedCount === totalCount) {
      return {
        text: "همه تنوع‌ها منتشر شده",
        className: "bg-green-100 text-green-700",
      };
    }

    if (publishedCount === 0) {
      return {
        text: "هیچ تنوعی منتشر نشده",
        className: "bg-slate-100 text-slate-700",
      };
    }

    return {
      text: `${publishedCount} از ${totalCount} تنوع منتشر شده`,
      className: "bg-blue-100 text-blue-700",
    };
  };

  const publicationStatus = getPublicationStatus();

  // Fetch variations on mount and when productId changes
  useEffect(() => {
    const fetchVariations = async () => {
      if (!productId) return;

      setIsLoading(true);
      try {
        const response = await apiClient.get(
          `/product-variations?filters[product][id][$eq]=${productId}&pagination[pageSize]=1000`,
          {
            cache: "no-store",
          },
        );

        // Type assertion to work with the data - response.data is the array of variations
        const fetchedVariations = (response.data as any) || [];
        setVariations(fetchedVariations);
      } catch (error: any) {
        console.error("Error fetching variations:", error);
        toast.error("خطا در دریافت تنوع‌ها");
      } finally {
        setIsLoading(false);
      }
    };

    fetchVariations();
  }, [productId, refreshKey]);

  const handlePublishAll = async () => {
    if (!canEdit) return;
    if (!productId || variations.length === 0) {
      toast.error("هیچ تنوعی برای این محصول یافت نشد");
      return;
    }

    setIsPublishing(true);
    try {
      let publishedCount = 0;
      let failedCount = 0;

      for (const variation of variations) {
        try {
          await apiClient.put(`/product-variations/${variation.id}`, {
            data: { IsPublished: true },
          });
          publishedCount++;
        } catch (error) {
          console.error(`Failed to publish variation ${variation.id}:`, error);
          failedCount++;
        }
      }

      if (publishedCount > 0) {
        toast.success(`${publishedCount} تنوع محصول منتشر شد`);
        // Refresh variations
        const response = await apiClient.get(
          `/product-variations?filters[product][id][$eq]=${productId}&pagination[pageSize]=1000`,
          {
            cache: "no-store",
          },
        );
        setVariations((response.data as any) || []);
      }

      if (failedCount > 0) {
        toast.error(`خطا در انتشار ${failedCount} تنوع`);
      }
    } catch (error: any) {
      console.error("Error publishing variations:", error);
      toast.error("خطا در انتشار تنوع‌ها");
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUnpublishAll = async () => {
    if (!canEdit) return;
    if (!productId || variations.length === 0) {
      toast.error("هیچ تنوعی برای این محصول یافت نشد");
      return;
    }

    setIsPublishing(true);
    try {
      let unpublishedCount = 0;
      let failedCount = 0;

      for (const variation of variations) {
        try {
          await apiClient.put(`/product-variations/${variation.id}`, {
            data: { IsPublished: false },
          });
          unpublishedCount++;
        } catch (error) {
          console.error(`Failed to unpublish variation ${variation.id}:`, error);
          failedCount++;
        }
      }

      if (unpublishedCount > 0) {
        toast.success(`${unpublishedCount} تنوع محصول از انتشار خارج شد`);
        // Refresh variations
        const response = await apiClient.get(
          `/product-variations?filters[product][id][$eq]=${productId}&pagination[pageSize]=1000`,
          {
            cache: "no-store",
          },
        );
        setVariations((response.data as any) || []);
      }

      if (failedCount > 0) {
        toast.error(`خطا در خارج کردن ${failedCount} تنوع از انتشار`);
      }
    } catch (error: any) {
      console.error("Error unpublishing variations:", error);
      toast.error("خطا در خارج کردن تنوع‌ها از انتشار");
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-white p-4">
      <div className="mb-2 flex w-full items-center justify-between gap-3">
        <h2 className="text-base text-neutral-600">انتشار تنوع‌ها</h2>

          <div className="flex items-center justify-center">
            <span
              className={`rounded-xl px-3 py-1.5 text-xs font-medium ${publicationStatus.className}`}
            >
              {publicationStatus.text}
            </span>
          </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-neutral-400">در حال بارگذاری...</div>
      ) : (
        <>


          {totalCount > 0 && (
            <div className="flex flex-row gap-2">
              {publishedCount < totalCount && (
                <button
                  onClick={handlePublishAll}
                  disabled={isPublishing || !canEdit}
                  className="w-full rounded-xl bg-green-500/10 hover:bg-green-500/80 hover:text-white border-green-200 border-2 px-4 py-2.5 text-sm text-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPublishing ? "در حال انتشار..." : "انتشار همه تنوع‌ها"}
                </button>
              )}

              {publishedCount > 0 && (
                <button
                  onClick={handleUnpublishAll}
                  disabled={isPublishing || !canEdit}
                  className="w-full rounded-xl bg-amber-500/10 hover:bg-amber-500/80 hover:text-white border-amber-200 border-2 px-4 py-2.5 text-sm text-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPublishing ? "در حال خارج کردن..." : "خارج کردن همه تنوع‌ها از انتشار"}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
