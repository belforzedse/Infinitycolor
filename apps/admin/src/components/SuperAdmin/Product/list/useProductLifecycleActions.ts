"use client";

import { useCallback, useMemo } from "react";
import toast from "react-hot-toast";
import { changeProductPublication, PRODUCT_PUBLICATION_TIMEZONE } from "@/services/super-admin/product/publication";
import {
  createProductPreviewLink,
  emptyProductTrash,
  moveProductToTrash,
  permanentlyDeleteProduct,
  restoreProductFromTrash,
  runBulkProductLifecycle,
  type BulkLifecycleAction,
  type BulkLifecycleResponse,
} from "@/services/super-admin/product/lifecycle";
import { duplicateProduct } from "@/services/super-admin/product/duplicate";
import { faNum } from "@/utils/faNum";
import {
  describeLifecycleError,
  describeRestoreWarnings,
  summariseBulkFailures,
} from "./productLifecycle";
import { showUndoToast } from "./undoToast";
import type { AdminProductRow } from "./types";

const BULK_VERB: Record<BulkLifecycleAction, string> = {
  publish: "منتشر شد",
  unpublish: "به پیش‌نویس برگشت",
  schedule: "زمان‌بندی شد",
  trash: "به سطل زباله منتقل شد",
  restore: "به پیش‌نویس‌ها بازیابی شد",
  purge: "برای همیشه حذف شد",
};

/**
 * Every Products lifecycle action the list offers, with its feedback. Each call
 * goes to the server's lifecycle commands (a single request even for bulk);
 * after any change `onChanged` refreshes the table and the tab counts.
 */
export function useProductLifecycleActions({ onChanged }: { onChanged: () => void }) {
  const title = (row: AdminProductRow) => `«${row.attributes.Title || `محصول ${row.id}`}»`;

  const restore = useCallback(
    async (row: AdminProductRow, undoToken?: string | null) => {
      try {
        const result = await restoreProductFromTrash(row.id, undoToken);
        onChanged();
        const restoredLabel =
          result.state === "published"
            ? "دوباره منتشر شد"
            : result.state === "scheduled"
              ? "با همان زمان‌بندی بازگردانده شد"
              : "به پیش‌نویس‌ها بازیابی شد";
        toast.success(`${title(row)} ${restoredLabel}`);
        const warnings = describeRestoreWarnings(result.warnings);
        if (warnings) toast(warnings, { icon: "⚠️", duration: 7_000 });
      } catch (error) {
        toast.error(describeLifecycleError(error, "بازیابی محصول انجام نشد"));
      }
    },
    [onChanged],
  );

  const trash = useCallback(
    async (row: AdminProductRow) => {
      try {
        const result = await moveProductToTrash(row.id);
        onChanged();
        showUndoToast({
          message: `${title(row)} به سطل زباله منتقل شد`,
          onUndo: () => restore(row, result.removedAt),
        });
      } catch (error) {
        toast.error(describeLifecycleError(error, "انتقال به سطل زباله انجام نشد"));
      }
    },
    [onChanged, restore],
  );

  const purge = useCallback(
    async (row: AdminProductRow) => {
      try {
        await permanentlyDeleteProduct(row.id);
        onChanged();
        toast.success(`${title(row)} برای همیشه حذف شد`);
      } catch (error) {
        toast.error(describeLifecycleError(error, "حذف دائمی انجام نشد"));
      }
    },
    [onChanged],
  );

  const setPublication = useCallback(
    async (
      row: AdminProductRow,
      action: "publish-now" | "unpublish" | "schedule",
      publishAt?: string,
    ) => {
      try {
        const result = await changeProductPublication(row.id, {
          action,
          ...(action === "schedule" ? { publishAt, timezone: PRODUCT_PUBLICATION_TIMEZONE } : {}),
        });
        onChanged();
        toast.success(
          action === "publish-now"
            ? result.publishedVariationCount
              ? `${title(row)} و ${faNum(result.publishedVariationCount)} تنوع آن منتشر شد`
              : `${title(row)} منتشر شد`
            : action === "schedule"
              ? `انتشار ${title(row)} زمان‌بندی شد`
              : `${title(row)} به پیش‌نویس‌ها برگشت`,
        );
        return true;
      } catch (error) {
        toast.error(describeLifecycleError(error, "تغییر وضعیت انتشار انجام نشد"));
        return false;
      }
    },
    [onChanged],
  );

  const bulk = useCallback(
    async (
      action: BulkLifecycleAction,
      rows: AdminProductRow[],
      extra: { publishAt?: string } = {},
    ): Promise<BulkLifecycleResponse | null> => {
      if (rows.length === 0) {
        toast.error("هیچ محصولی انتخاب نشده است");
        return null;
      }
      const progress = toast.loading(`در حال پردازش ${faNum(rows.length)} محصول...`);
      try {
        const result = await runBulkProductLifecycle({
          action,
          ids: rows.map((row) => row.id),
          ...(extra.publishAt
            ? { publishAt: extra.publishAt, timezone: PRODUCT_PUBLICATION_TIMEZONE }
            : {}),
        });
        toast.dismiss(progress);
        if (result.succeeded.length > 0) {
          toast.success(`${faNum(result.succeeded.length)} محصول ${BULK_VERB[action]}`);
        }
        if (result.unchanged.length > 0) {
          toast(`${faNum(result.unchanged.length)} محصول از قبل در همین وضعیت بود.`, { icon: "ℹ️" });
        }
        if (result.failed.length > 0) {
          toast.error(
            `${faNum(result.failed.length)} محصول تغییر نکرد: ${summariseBulkFailures(result.failed)}`,
            { duration: 8_000 },
          );
        }
        const warned = result.warnings.length;
        if (warned > 0) {
          toast(`${faNum(warned)} محصول بازیابی‌شده پیش از انتشار نیاز به بررسی دارد.`, { icon: "⚠️" });
        }
        if (result.succeeded.length > 0) onChanged();
        return result;
      } catch (error) {
        toast.dismiss(progress);
        toast.error(describeLifecycleError(error, "عملیات گروهی انجام نشد"));
        return null;
      }
    },
    [onChanged],
  );

  /** Empties Trash in server-sized batches, up to what the admin was looking at. */
  const emptyTrash = useCallback(
    async (trashedBefore: string) => {
      const progress = toast.loading("در حال خالی کردن سطل زباله...");
      let purged = 0;
      let failed = 0;
      try {
        for (let round = 0; round < 50; round += 1) {
          const batch = await emptyProductTrash(trashedBefore);
          purged += batch.purged;
          failed += batch.failed;
          if (batch.remaining === 0 || batch.purged === 0) break;
          toast.loading(`${faNum(purged)} محصول حذف شد؛ ادامه دارد...`, { id: progress });
        }
        toast.dismiss(progress);
        toast.success(`${faNum(purged)} محصول برای همیشه حذف شد`);
        if (failed > 0) toast.error(`${faNum(failed)} محصول حذف نشد؛ دوباره تلاش کنید.`);
      } catch (error) {
        toast.dismiss(progress);
        toast.error(describeLifecycleError(error, "خالی کردن سطل زباله انجام نشد"));
      } finally {
        if (purged > 0) onChanged();
      }
    },
    [onChanged],
  );

  const preview = useCallback(async (row: AdminProductRow) => {
    // Open synchronously so the popup blocker treats it as user-initiated, then
    // detach the opener (a "noopener" feature string would return null here).
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const url = await createProductPreviewLink(row.id);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      tab?.close();
      toast.error(describeLifecycleError(error, "ساخت پیش‌نمایش انجام نشد"));
    }
  }, []);

  const duplicate = useCallback(
    async (row: AdminProductRow) => {
      const result = await duplicateProduct(row.id);
      if (result.success) onChanged();
    },
    [onChanged],
  );

  // Stable identity, so the page's column and bulk-action memos hold.
  return useMemo(
    () => ({ trash, restore, purge, setPublication, bulk, emptyTrash, preview, duplicate }),
    [bulk, duplicate, emptyTrash, preview, purge, restore, setPublication, trash],
  );
}
