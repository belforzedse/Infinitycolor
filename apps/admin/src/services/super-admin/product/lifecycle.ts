import { apiClient } from "@/services";
import type { ProductLifecycleState } from "@/components/SuperAdmin/Product/list/types";

/**
 * Product lifecycle commands. Every rule — which transition is allowed, who
 * may run it, what happens to caches, schedules and the storefront — is the
 * server's (apps/backend/src/api/product/services/product-lifecycle.ts); these
 * are thin calls.
 */

export type RestoreWarning =
  | "UNDO_EXPIRED"
  | "UNDO_PUBLISH_NOT_ALLOWED"
  | "UNDO_SCHEDULE_NOT_ALLOWED"
  | "SCHEDULE_EXPIRED"
  | "SLUG_IN_USE"
  | "MAIN_CATEGORY_MISSING"
  | "COVER_IMAGE_MISSING"
  | "NO_PUBLISHABLE_VARIATION"
  | "SKU_CONFLICT";

export type ProductLifecycleResponse = {
  id: number;
  state: ProductLifecycleState;
  Status: "Active" | "InActive" | "Scheduled";
  /** Returned by Move to Trash; send it back as the Undo token. */
  removedAt: string | null;
  previousStatus: "Active" | "InActive" | "Scheduled" | null;
  warnings: RestoreWarning[];
  /** True when the product was already in the requested state. */
  unchanged: boolean;
};

export type BulkLifecycleAction = "publish" | "unpublish" | "schedule" | "trash" | "restore" | "purge";

export type BulkLifecycleResponse = {
  action: BulkLifecycleAction;
  succeeded: number[];
  unchanged: number[];
  failed: Array<{ id: number; code: string }>;
  warnings: Array<{ id: number; warnings: RestoreWarning[] }>;
  results?: Array<{ productId: number; changed: boolean; state: ProductLifecycleState; status: "Active" | "InActive" | "Scheduled"; removedAt: string | null; previousStatus: "Active" | "InActive" | "Scheduled" | null; warnings: RestoreWarning[] }>;
};

const COMMAND_OPTIONS = { retries: 0, timeout: 20_000 } as const;

export async function moveProductToTrash(productId: string | number): Promise<ProductLifecycleResponse> {
  return runSingleLifecycle("trash", productId);
}

/** Restores to draft. With the token from Move to Trash it is the bounded Undo. */
export async function restoreProductFromTrash(
  productId: string | number,
  undoToken?: string | null,
): Promise<ProductLifecycleResponse> {
  return runSingleLifecycle("restore", productId, undoToken);
}

export async function permanentlyDeleteProduct(
  productId: string | number,
): Promise<ProductLifecycleResponse> {
  return runSingleLifecycle("purge", productId);
}

async function runSingleLifecycle(action: BulkLifecycleAction, id: string | number, undoToken?: string | null): Promise<ProductLifecycleResponse> {
  const bulk = await runBulkProductLifecycle({ action, ids: [id], undoToken });
  if (bulk.failed.length) throw { errorCode: bulk.failed[0].code };
  const result = bulk.results?.find((item) => item.productId === Number(id));
  if (!result) throw { errorCode: "LIFECYCLE_RESULT_UNCERTAIN" };
  return { id: result.productId, state: result.state, Status: result.status, removedAt: result.removedAt, previousStatus: result.previousStatus, warnings: result.warnings, unchanged: !result.changed };
}

export async function runBulkProductLifecycle(input: {
  action: BulkLifecycleAction;
  ids: Array<string | number>;
  publishAt?: string;
  timezone?: string;
  undoToken?: string | null;
}): Promise<BulkLifecycleResponse> {
  const response = await apiClient.post<BulkLifecycleResponse>(
    "/products/lifecycle/bulk",
    {
      data: {
        action: input.action,
        ids: input.ids.map(Number),
        ...(input.undoToken ? { undoToken: input.undoToken } : {}),
        ...(input.publishAt ? { publishAt: input.publishAt, timezone: input.timezone } : {}),
      },
    },
    // A hundred products each commit their own transaction server-side.
    { retries: 0, timeout: 120_000 },
  );
  return response.data as BulkLifecycleResponse;
}

/** One batch of Empty Trash; repeat while `remaining > 0` and progress is made. */
export async function emptyProductTrash(
  trashedBefore: string,
): Promise<{ purged: number; failed: number; remaining: number }> {
  const response = await apiClient.post<{ purged: number; failed: number; remaining: number }>(
    "/products/trash/empty",
    { data: { trashedBefore } },
    { retries: 0, timeout: 120_000 },
  );
  return response.data as { purged: number; failed: number; remaining: number };
}

/** A storefront preview of the saved product through the existing preview-draft token. */
export async function createProductPreviewLink(productId: string | number): Promise<string> {
  const response = await apiClient.post<{ token: string; url: string }>(
    `/products/${productId}/preview-draft`,
    { data: {} },
    COMMAND_OPTIONS,
  );
  return (response.data as { url: string }).url;
}
