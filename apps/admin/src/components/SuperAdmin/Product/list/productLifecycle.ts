import type { BadgeTone } from "@/components/admin";
import type {
  AdminProductSort,
  AdminProductView,
} from "@/services/super-admin/product/list";
import type { RestoreWarning } from "@/services/super-admin/product/lifecycle";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import { formatTehranPublication } from "@/utils/tehranPublicationTime";
import type { AdminProductRow, ProductLifecycleState, ProductPublicationStatus } from "./types";

/**
 * Client-side mirror of the product lifecycle, used only to decide what to
 * offer. The server re-checks every transition and capability
 * (apps/backend/src/api/product/services/product-lifecycle-rules.ts); nothing
 * here is authorization.
 */

export const PRODUCT_VIEW_TABS: Array<{ key: AdminProductView; label: string }> = [
  { key: "all", label: "همه" },
  { key: "published", label: "منتشر شده" },
  { key: "drafts", label: "پیش‌نویس‌ها" },
  { key: "scheduled", label: "زمان‌بندی شده" },
  { key: "trash", label: "سطل زباله" },
];

export const VIEW_EMPTY_STATE: Record<AdminProductView, { title: string; description?: string }> = {
  all: { title: "هنوز محصولی ثبت نشده است." },
  published: {
    title: "محصول منتشرشده‌ای وجود ندارد.",
    description: "محصولات پیش‌نویس را از زبانهٔ «پیش‌نویس‌ها» منتشر کنید.",
  },
  drafts: { title: "پیش‌نویسی وجود ندارد." },
  scheduled: {
    title: "هیچ محصولی برای انتشار زمان‌بندی نشده است.",
    description: "از زبانهٔ «پیش‌نویس‌ها» می‌توانید زمان انتشار تعیین کنید.",
  },
  trash: { title: "سطل زباله خالی است." },
};

export const SORT_LABELS: Record<AdminProductSort, string> = {
  "last-edited": "آخرین ویرایش",
  newest: "جدیدترین",
  oldest: "قدیمی‌ترین",
  updated: "آخرین تغییر",
  title: "نام محصول",
  published: "تاریخ انتشار",
  "scheduled-asc": "زمان انتشار: نزدیک‌ترین",
  "scheduled-desc": "زمان انتشار: دورترین",
  "trashed-desc": "حذف: جدیدترین",
  "trashed-asc": "حذف: قدیمی‌ترین",
  "stock-desc": "موجودی: بیشترین",
  "stock-asc": "موجودی: کمترین",
  "sales-desc": "فروش ۳۰ روز: بیشترین",
  "sales-asc": "فروش ۳۰ روز: کمترین",
};

const COMMON_SORTS: AdminProductSort[] = [
  "last-edited",
  "newest",
  "oldest",
  "updated",
  "title",
  "stock-desc",
  "stock-asc",
  "sales-desc",
  "sales-asc",
];

export const SORTS_BY_VIEW: Record<AdminProductView, AdminProductSort[]> = {
  all: COMMON_SORTS,
  published: ["last-edited", "published", ...COMMON_SORTS.slice(1)],
  drafts: COMMON_SORTS,
  scheduled: ["scheduled-asc", "scheduled-desc", ...COMMON_SORTS],
  trash: ["trashed-desc", "trashed-asc", ...COMMON_SORTS],
};

export const DEFAULT_SORT_BY_VIEW: Record<AdminProductView, AdminProductSort> = {
  all: "last-edited",
  published: "last-edited",
  drafts: "last-edited",
  scheduled: "scheduled-asc",
  trash: "trashed-desc",
};

export const PUBLICATION_STATUS_LABEL: Record<ProductPublicationStatus, string> = {
  Active: "منتشر شده",
  InActive: "پیش‌نویس",
  Scheduled: "زمان‌بندی شده",
};

export function lifecycleStateOf(row: AdminProductRow): ProductLifecycleState {
  const attributes = row.attributes;
  if (attributes.lifecycleState) return attributes.lifecycleState;
  if (attributes.removedAt) return "trashed";
  if (attributes.Status === "Active") return "published";
  if (attributes.Status === "Scheduled") return "scheduled";
  return "draft";
}

export function lifecycleBadge(row: AdminProductRow): { label: string; tone: BadgeTone; detail?: string } {
  const state = lifecycleStateOf(row);
  const attributes = row.attributes;
  if (state === "trashed") return { label: "در سطل زباله", tone: "danger" };
  if (state === "published") return { label: "منتشر شده", tone: "success" };
  if (state === "scheduled") {
    const detail = attributes.scheduledPublishAt
      ? formatTehranPublication(attributes.scheduledPublishAt)
      : undefined;
    return attributes.scheduledPublishLastError
      ? { label: "خطای انتشار زمان‌بندی‌شده", tone: "danger", detail }
      : { label: "زمان‌بندی شده", tone: "info", detail };
  }
  return { label: "پیش‌نویس", tone: "neutral" };
}

export type ProductLifecycleCapabilities = {
  publish: boolean;
  schedule: boolean;
  softDelete: boolean;
  restore: boolean;
  delete: boolean;
  duplicate: boolean;
  stock: boolean;
};

export type ProductRowActionId =
  | "edit"
  | "view"
  | "preview"
  | "duplicate"
  | "publish"
  | "schedule"
  | "reschedule"
  | "unpublish"
  | "trash"
  | "restore"
  | "purge";

/** Which row actions a state offers, in menu order, for the capabilities held. */
export function rowActionsFor(
  state: ProductLifecycleState,
  can: ProductLifecycleCapabilities,
): ProductRowActionId[] {
  const pick = (entries: Array<[ProductRowActionId, boolean]>) =>
    entries.filter(([, allowed]) => allowed).map(([id]) => id);
  switch (state) {
    case "published":
      return pick([
        ["edit", true],
        ["view", true],
        ["duplicate", can.duplicate],
        ["unpublish", can.publish],
        ["trash", can.softDelete],
      ]);
    case "draft":
      return pick([
        ["edit", true],
        ["preview", true],
        ["duplicate", can.duplicate],
        ["publish", can.publish],
        ["schedule", can.schedule],
        ["trash", can.softDelete],
      ]);
    case "scheduled":
      return pick([
        ["edit", true],
        ["preview", true],
        ["duplicate", can.duplicate],
        ["reschedule", can.schedule],
        ["publish", can.publish],
        ["unpublish", can.publish],
        ["trash", can.softDelete],
      ]);
    case "trashed":
      return pick([
        ["restore", can.restore],
        ["purge", can.delete],
      ]);
    default:
      return [];
  }
}

export const DESTRUCTIVE_ROW_ACTIONS = new Set<ProductRowActionId>(["trash", "purge"]);

export type ProductBulkActionId =
  | "publish"
  | "unpublish"
  | "schedule"
  | "trash"
  | "restore"
  | "purge"
  | "set_stock"
  | "remove_stock";

/** Bulk actions each tab offers; the server skips items whose state disallows one. */
export function bulkActionsFor(
  view: AdminProductView,
  can: ProductLifecycleCapabilities,
): ProductBulkActionId[] {
  const stock: Array<[ProductBulkActionId, boolean]> = [
    ["set_stock", can.stock],
    ["remove_stock", can.stock],
  ];
  const entries: Array<[ProductBulkActionId, boolean]> =
    view === "trash"
      ? [
          ["restore", can.restore],
          ["purge", can.delete],
        ]
      : view === "published"
        ? [["unpublish", can.publish], ["trash", can.softDelete], ...stock]
        : view === "drafts"
          ? [["publish", can.publish], ["schedule", can.schedule], ["trash", can.softDelete], ...stock]
          : view === "scheduled"
            ? [["publish", can.publish], ["schedule", can.schedule], ["unpublish", can.publish], ["trash", can.softDelete]]
            : [
                ["publish", can.publish],
                ["schedule", can.schedule],
                ["unpublish", can.publish],
                ["trash", can.softDelete],
                ...stock,
              ];
  return entries.filter(([, allowed]) => allowed).map(([id]) => id);
}

/** The phrase an operator types to confirm a permanent deletion. */
export const PERMANENT_DELETE_PHRASE = "حذف دائمی";

const LIFECYCLE_ERROR_MESSAGES: Record<string, string> = {
  PRODUCT_NOT_IN_TRASH: "حذف دائمی فقط برای محصولات داخل سطل زباله ممکن است.",
  PRODUCT_PURGED: "این محصول قبلاً برای همیشه حذف شده است.",
  PRODUCT_REMOVED: "این محصول در سطل زباله است؛ ابتدا آن را بازیابی کنید.",
  PRODUCT_SLUG_CONFLICT:
    "نامک این محصول را محصول منتشرشدهٔ دیگری استفاده می‌کند؛ نامک را تغییر دهید و دوباره منتشر کنید.",
  SCHEDULED_UPDATE_UNSUPPORTED:
    "محصول منتشرشده را نمی‌توان زمان‌بندی کرد؛ ابتدا آن را به پیش‌نویس برگردانید.",
  INVALID_PUBLICATION_TIME: "زمان انتشار باید در آینده باشد.",
  UNSUPPORTED_PUBLICATION_TIMEZONE: "زمان انتشار باید به وقت تهران باشد.",
  PRODUCT_TITLE_REQUIRED: "برای انتشار، عنوان محصول لازم است.",
  PRODUCT_SLUG_REQUIRED: "قبل از انتشار، نامک محصول را ذخیره کنید.",
  PRODUCT_NOT_FOUND: "محصول پیدا نشد؛ صفحه را تازه کنید.",
  PRODUCT_NOT_SCHEDULED: "این محصول زمان‌بندی نشده است.",
  BULK_LIMIT_EXCEEDED: "در هر بار حداکثر ۱۰۰ محصول را می‌توان پردازش کرد.",
  BULK_IDS_REQUIRED: "هیچ محصولی انتخاب نشده است.",
  LIFECYCLE_FORBIDDEN: "شما اجازهٔ انجام این کار را ندارید.",
  PUBLICATION_FORBIDDEN: "شما اجازهٔ انجام این کار را ندارید.",
  LIFECYCLE_COMMAND_FAILED: "عملیات انجام نشد؛ صفحه را تازه کنید و دوباره تلاش کنید.",
};

export function lifecycleErrorCode(error: unknown): string | undefined {
  const candidate = error as {
    details?: { code?: string };
    errorCode?: string;
    message?: string;
  } | null;
  return candidate?.details?.code || candidate?.errorCode || candidate?.message || undefined;
}

export function describeLifecycleCode(code: string | undefined): string | undefined {
  return code ? LIFECYCLE_ERROR_MESSAGES[code] : undefined;
}

export function describeLifecycleError(error: unknown, fallback = "عملیات انجام نشد"): string {
  return describeLifecycleCode(lifecycleErrorCode(error)) || getUserFacingErrorMessage(error, fallback);
}

export const RESTORE_WARNING_MESSAGES: Record<RestoreWarning, string> = {
  UNDO_EXPIRED: "مهلت بازگردانی گذشته بود؛ محصول به‌صورت پیش‌نویس بازیابی شد.",
  UNDO_PUBLISH_NOT_ALLOWED: "اجازهٔ انتشار ندارید؛ محصول به‌صورت پیش‌نویس بازیابی شد.",
  UNDO_SCHEDULE_NOT_ALLOWED: "اجازهٔ زمان‌بندی ندارید؛ محصول به‌صورت پیش‌نویس بازیابی شد.",
  SCHEDULE_EXPIRED: "زمان انتشار قبلی گذشته است؛ محصول به‌صورت پیش‌نویس بازیابی شد.",
  SLUG_IN_USE: "نامک این محصول اکنون متعلق به محصول منتشرشدهٔ دیگری است؛ پیش از انتشار آن را تغییر دهید.",
  MAIN_CATEGORY_MISSING: "دسته‌بندی اصلی این محصول دیگر وجود ندارد.",
  COVER_IMAGE_MISSING: "تصویر شاخص این محصول موجود نیست.",
  NO_PUBLISHABLE_VARIATION: "این محصول تنوع قیمت‌دار ندارد.",
  SKU_CONFLICT: "کد SKU یکی از تنوع‌ها با محصول دیگری تکراری است.",
};

export function describeRestoreWarnings(warnings: RestoreWarning[] | undefined): string | null {
  const messages = (warnings || []).map((warning) => RESTORE_WARNING_MESSAGES[warning]).filter(Boolean);
  return messages.length ? messages.join(" ") : null;
}

/** Summarises a bulk result for one toast; distinct failure reasons only. */
export function summariseBulkFailures(failed: Array<{ id: number; code: string }>): string {
  const reasons = [...new Set(failed.map((entry) => describeLifecycleCode(entry.code) || entry.code))];
  return reasons.join("؛ ");
}
