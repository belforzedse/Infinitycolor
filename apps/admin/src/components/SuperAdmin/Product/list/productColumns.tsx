"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ImageOff } from "lucide-react";
import { StatusBadge } from "@/components/admin";
import SuperAdminTableCellSimplePrice from "@/components/SuperAdmin/Table/Cells/SimplePrice";
import SuperAdminTableCellFullDateTime from "@/components/SuperAdmin/Table/Cells/FullDateTime";
import { TEHRAN_TIMEZONE } from "@/utils/tehranPublicationTime";
import { faNum } from "@/utils/faNum";
import type { AdminProductView } from "@/services/super-admin/product/list";
import { describeLifecycleCode, lifecycleBadge, PUBLICATION_STATUS_LABEL } from "./productLifecycle";
import {
  formatTehranDate,
  formatTehranTime,
  productPrice,
  productPrimarySku,
  productStockTotal,
  productThumbnailUrl,
  productVariationSummary,
} from "./productFormat";
import type { AdminProductRow } from "./types";

type Column = ColumnDef<AdminProductRow>;

export function ProductThumbnail({ row, size = 48 }: { row: AdminProductRow; size?: number }) {
  const url = productThumbnailUrl(row);
  const style = { width: size, height: size };
  if (!url) {
    return (
      <div className="flex shrink-0 items-center justify-center rounded-xl bg-slate-100" style={style}>
        <ImageOff className="h-5 w-5 text-slate-400" aria-hidden />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={row.attributes.Title || "تصویر محصول"}
      className="shrink-0 rounded-xl object-cover"
      style={style}
      loading="lazy"
    />
  );
}

const productColumn: Column = {
  id: "product",
  header: "محصول",
  cell: ({ row }) => {
    const sku = productPrimarySku(row.original);
    return (
      <div className="flex min-w-0 items-center gap-3">
        <ProductThumbnail row={row.original} />
        <div
          className="flex min-w-0 flex-col gap-1"
          data-testid="admin-product-row"
          data-product-id={row.original.id}
          data-product-title={row.original.attributes.Title}
          data-product-sku={sku ?? undefined}
        >
          <span className="max-w-[18rem] break-words text-sm leading-6 text-foreground-primary">
            {row.original.attributes.Title}
          </span>
          <span className="text-xs text-foreground-secondary" dir="ltr">
            {sku || "بدون SKU"}
          </span>
        </div>
      </div>
    );
  },
};

const categoryColumn: Column = {
  id: "category",
  header: "دسته‌بندی",
  cell: ({ row }) =>
    row.original.attributes.product_main_category?.data?.attributes?.Title || (
      <span className="text-xs text-slate-400">بدون دسته</span>
    ),
};

const priceColumn: Column = {
  id: "price",
  header: "قیمت",
  cell: ({ row }) => {
    const price = productPrice(row.original);
    if (!price) return <span className="text-xs text-amber-700">بدون قیمت</span>;
    return (
      <div className="flex flex-col">
        {price.discount !== null && (
          <span className="font-medium text-infinity-primary">
            <SuperAdminTableCellSimplePrice price={price.discount} />
          </span>
        )}
        <span className={price.discount !== null ? "text-xs text-gray-500 line-through" : ""}>
          <SuperAdminTableCellSimplePrice price={price.price} />
        </span>
      </div>
    );
  },
};

const stockColumn: Column = {
  id: "stock",
  header: "موجودی",
  cell: ({ row }) => {
    const total = productStockTotal(row.original);
    return (
      <StatusBadge
        label={total > 0 ? `${faNum(total)} عدد` : "ناموجود"}
        tone={total > 0 ? "success" : "danger"}
      />
    );
  },
};

const statusColumn: Column = {
  id: "status",
  header: "وضعیت",
  cell: ({ row }) => {
    const badge = lifecycleBadge(row.original);
    const variations = productVariationSummary(row.original);
    return (
      <div className="flex flex-col items-start gap-1">
        <StatusBadge label={badge.label} tone={badge.tone} />
        {badge.detail && <span className="text-[11px] text-slate-500">{badge.detail}</span>}
        <span className="whitespace-nowrap text-[11px] text-slate-400">
          {variations.total === 0
            ? "بدون تنوع"
            : `${faNum(variations.published)} از ${faNum(variations.total)} تنوع منتشر`}
        </span>
      </div>
    );
  },
};

const publishedAtColumn: Column = {
  id: "publishedAt",
  header: "تاریخ انتشار",
  cell: ({ row }) =>
    row.original.attributes.PublishedAt ? (
      <SuperAdminTableCellFullDateTime date={new Date(row.original.attributes.PublishedAt)} />
    ) : (
      "-"
    ),
};

const scheduleColumn: Column = {
  id: "schedule",
  header: "زمان انتشار",
  cell: ({ row }) => {
    const at = row.original.attributes.scheduledPublishAt;
    if (!at) return "-";
    const error = row.original.attributes.scheduledPublishLastError;
    return (
      <div className="flex flex-col gap-0.5" data-testid="admin-product-scheduled-at">
        <span className="text-sm text-foreground-primary">{formatTehranDate(at)}</span>
        <span className="text-xs text-slate-600">
          ساعت {formatTehranTime(at)} <span className="text-slate-400">({TEHRAN_TIMEZONE})</span>
        </span>
        {error && (
          <span className="text-[11px] text-red-600">
            انتشار ناموفق{row.original.attributes.scheduledPublishFailureKind === "Permanent" ? " (نیاز به اصلاح)" : ""}:{" "}
            {describeLifecycleCode(error) || error}
          </span>
        )}
      </div>
    );
  },
};

const lastEditedColumn: Column = {
  id: "lastEdited",
  header: "آخرین ویرایش",
  cell: ({ row }) => {
    const value = row.original.attributes.LastEditedByAdminAt || row.original.attributes.updatedAt;
    return value ? <SuperAdminTableCellFullDateTime date={new Date(value)} /> : "-";
  },
};

const previousStatusColumn: Column = {
  id: "previousStatus",
  header: "وضعیت پیش از حذف",
  cell: ({ row }) => {
    const previous = row.original.attributes.preRemovalStatus;
    const previousSchedule = row.original.attributes.preRemovalScheduledPublishAt;
    if (!previous) return "-";
    return (
      <div className="flex flex-col items-start gap-1">
        <StatusBadge
          label={PUBLICATION_STATUS_LABEL[previous]}
          tone={previous === "Active" ? "success" : previous === "Scheduled" ? "info" : "neutral"}
          size="sm"
        />
        {previous === "Scheduled" && previousSchedule && (
          <span className="text-[11px] text-slate-500">
            برای {formatTehranDate(previousSchedule)} ساعت {formatTehranTime(previousSchedule)}
          </span>
        )}
      </div>
    );
  },
};

const trashedColumn: Column = {
  id: "trashed",
  header: "حذف شده",
  cell: ({ row }) => {
    const at = row.original.attributes.removedAt;
    return (
      <div className="flex flex-col gap-0.5">
        {at ? <SuperAdminTableCellFullDateTime date={new Date(at)} /> : "-"}
        <span className="text-[11px] text-slate-500">
          توسط {row.original.attributes.removedByLabel || "نامشخص"}
        </span>
      </div>
    );
  },
};

const purgeAtColumn: Column = {
  id: "purgeAt",
  header: "حذف خودکار",
  cell: ({ row }) => {
    const at = row.original.attributes.purgeAt;
    return at ? <span className="text-xs text-red-700">{formatTehranDate(at)}</span> : "-";
  },
};

/**
 * One table definition for every lifecycle tab: the shared identity columns
 * plus the few that matter for the tab (publish time for Scheduled, who and
 * when for Trash). Actions are rendered by the caller so they can open the
 * page's dialogs.
 */
export function buildProductColumns({
  view,
  showRetention,
  renderActions,
}: {
  view: AdminProductView;
  showRetention: boolean;
  renderActions: (row: AdminProductRow) => React.ReactNode;
}): Column[] {
  const actions: Column = {
    id: "actions",
    header: "عملیات",
    meta: { headerClassName: "text-left", cellClassName: "text-left" },
    cell: ({ row }) => renderActions(row.original),
  };

  switch (view) {
    case "scheduled":
      return [productColumn, scheduleColumn, statusColumn, categoryColumn, lastEditedColumn, actions];
    case "trash":
      return [
        productColumn,
        previousStatusColumn,
        trashedColumn,
        ...(showRetention ? [purgeAtColumn] : []),
        categoryColumn,
        actions,
      ];
    case "published":
      return [productColumn, categoryColumn, priceColumn, stockColumn, publishedAtColumn, lastEditedColumn, actions];
    case "drafts":
      return [productColumn, categoryColumn, priceColumn, stockColumn, statusColumn, lastEditedColumn, actions];
    default:
      return [productColumn, categoryColumn, priceColumn, stockColumn, statusColumn, lastEditedColumn, actions];
  }
}
