"use client";

import {
  ArchiveRestore,
  CalendarClock,
  Copy,
  Eye,
  ExternalLink,
  Pencil,
  Rocket,
  Trash2,
  Undo2,
  XOctagon,
} from "lucide-react";
import Link from "next/link";
import { OverflowMenu, type OverflowAction } from "@/components/admin";
import { cn } from "@/utils/tailwind";
import {
  DESTRUCTIVE_ROW_ACTIONS,
  lifecycleStateOf,
  rowActionsFor,
  type ProductLifecycleCapabilities,
  type ProductRowActionId,
} from "./productLifecycle";
import { storefrontProductUrl } from "./productFormat";
import type { AdminProductRow } from "./types";

const ICON = "h-4 w-4 shrink-0";

const ACTION_META: Record<
  ProductRowActionId,
  { label: (row: AdminProductRow) => string; icon: React.ReactNode; testId?: string }
> = {
  edit: { label: () => "ویرایش", icon: <Pencil className={ICON} aria-hidden /> },
  view: { label: () => "مشاهده در فروشگاه", icon: <ExternalLink className={ICON} aria-hidden /> },
  preview: { label: () => "پیش‌نمایش", icon: <Eye className={ICON} aria-hidden /> },
  duplicate: {
    label: () => "دوبل کردن",
    icon: <Copy className={ICON} aria-hidden />,
    testId: "admin-product-duplicate",
  },
  publish: {
    label: (row) => (lifecycleStateOf(row) === "scheduled" ? "انتشار فوری" : "انتشار"),
    icon: <Rocket className={ICON} aria-hidden />,
    testId: "admin-product-publish",
  },
  schedule: {
    label: () => "زمان‌بندی انتشار",
    icon: <CalendarClock className={ICON} aria-hidden />,
    testId: "admin-product-schedule",
  },
  reschedule: {
    label: () => "تغییر زمان انتشار",
    icon: <CalendarClock className={ICON} aria-hidden />,
    testId: "admin-product-schedule",
  },
  unpublish: {
    label: () => "بازگشت به پیش‌نویس",
    icon: <Undo2 className={ICON} aria-hidden />,
    testId: "admin-product-unpublish",
  },
  trash: {
    label: () => "انتقال به سطل زباله",
    icon: <Trash2 className={ICON} aria-hidden />,
    testId: "admin-product-soft-delete",
  },
  restore: {
    label: () => "بازیابی به پیش‌نویس",
    icon: <ArchiveRestore className={ICON} aria-hidden />,
    testId: "admin-product-restore",
  },
  purge: {
    label: () => "حذف دائمی",
    icon: <XOctagon className={ICON} aria-hidden />,
    testId: "admin-product-permanent-delete",
  },
};

/**
 * Contextual row actions: the actions a product's state allows (see
 * `rowActionsFor`), with Edit kept as a visible button because it is the
 * everyday action and the rest in the shared overflow menu, destructive ones
 * separated and in red.
 */
export default function ProductRowActions({
  row,
  can,
  onAction,
  className,
}: {
  row: AdminProductRow;
  can: ProductLifecycleCapabilities;
  onAction: (action: ProductRowActionId, row: AdminProductRow) => void;
  className?: string;
}) {
  const state = lifecycleStateOf(row);
  const available = rowActionsFor(state, can);
  const menuActions: OverflowAction[] = available
    .filter((id) => id !== "edit")
    .map((id) => {
      const meta = ACTION_META[id];
      const common = {
        id,
        label: meta.label(row),
        icon: meta.icon,
        destructive: DESTRUCTIVE_ROW_ACTIONS.has(id),
        testId: meta.testId,
        dataAttributes: { id: row.id },
      };
      if (id === "view") {
        const url = storefrontProductUrl(row);
        return { ...common, disabled: !url, onSelect: () => url && window.open(url, "_blank", "noopener,noreferrer") };
      }
      return { ...common, onSelect: () => onAction(id, row) };
    });

  return (
    <div className={cn("flex items-center justify-end gap-2", className)}>
      {available.includes("edit") && (
        <Link
          href={`/products/${row.id}`}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
          data-testid="admin-product-edit"
          data-id={row.id}
          onClick={(event) => event.stopPropagation()}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          ویرایش
        </Link>
      )}
      <OverflowMenu
        actions={menuActions}
        label={`عملیات محصول ${row.attributes.Title}`}
        triggerTestId="admin-product-actions"
        triggerDataAttributes={{ id: row.id }}
      />
    </div>
  );
}
