import type { ProductCoverImage } from "@/types/Product";

export type ProductPublicationStatus = "Active" | "InActive" | "Scheduled";

/** Publication and deletion folded into one state (mirrors the backend). */
export type ProductLifecycleState = "published" | "draft" | "scheduled" | "trashed" | "purged";

/** One row of `POST /admin/products-list/query` (the compact list projection). */
export type AdminProductRow = {
  id: string;
  attributes: {
    lifecycleState: ProductLifecycleState;
    removedAt: string | null;
    removedById?: number | null;
    removedByLabel?: string | null;
    preRemovalStatus?: ProductPublicationStatus | null;
    preRemovalScheduledPublishAt?: string | null;
    /** When automatic Trash cleanup will permanently delete it; null when off. */
    purgeAt?: string | null;
    Title: string;
    Slug?: string | null;
    Status: ProductPublicationStatus | null;
    PublishedAt?: string | null;
    scheduledPublishAt?: string | null;
    scheduledPublishTimezone?: string | null;
    scheduledPublishLastAttemptAt?: string | null;
    scheduledPublishLastError?: string | null;
    scheduledPublishFailureKind?: "Transient" | "Permanent" | null;
    ProductType?: "Simple" | "Variable" | null;
    AverageRating: number | null;
    RatingCount: number | null;
    createdAt: string;
    updatedAt: string;
    LastEditedByAdminAt: string | null;
    product_main_category: {
      data: { id: number; attributes: { Title: string | null } } | null;
    };
    product_variations: {
      data: Array<{
        id: number;
        attributes: {
          IsPublished: boolean;
          SKU: string | null;
          Price: string | null;
          DiscountPrice?: string | null;
          product_stock: {
            data: { id: number; attributes: { Count: number } } | null;
          };
        };
      }>;
    };
    CoverImage: ProductCoverImage;
  };
};
