"use client";

import { ResourceList, ResourceListItem, StatusBadge } from "@/components/admin";
import { priceFormatter } from "@/utils/price";
import { faNum } from "@/utils/faNum";
import { formatFaRelativeDateTime } from "@/utils/formatFaRelativeDateTime";
import type { AdminProductView } from "@/services/super-admin/product/list";
import { lifecycleBadge, lifecycleStateOf, PUBLICATION_STATUS_LABEL } from "./productLifecycle";
import { ProductThumbnail } from "./productColumns";
import {
  formatTehranDate,
  formatTehranTime,
  productPrice,
  productPrimarySku,
  productStockTotal,
} from "./productFormat";
import type { AdminProductRow } from "./types";

type SelectionProps = {
  enableSelection: boolean;
  selectedIds: Set<string>;
  onSelectionChange: (id: string, selected: boolean) => void;
};

/**
 * Below the `lg` breakpoint the list becomes cards (the same boundary every
 * admin list uses), with the tab-specific facts in the meta strip and the same
 * contextual actions as the table.
 */
export default function ProductMobileList({
  data,
  view,
  selectionProps,
  renderActions,
}: {
  data: AdminProductRow[] | undefined;
  view: AdminProductView;
  selectionProps?: SelectionProps;
  renderActions: (row: AdminProductRow) => React.ReactNode;
}) {
  if (!data) return null;

  return (
    <ResourceList className="mt-2">
      {data.map((row) => {
        const badge = lifecycleBadge(row);
        const state = lifecycleStateOf(row);
        const price = productPrice(row);
        const stock = productStockTotal(row);
        const sku = productPrimarySku(row);
        const attributes = row.attributes;
        const meta: React.ReactNode[] =
          state === "trashed"
            ? [
                attributes.preRemovalStatus
                  ? `پیش از حذف: ${PUBLICATION_STATUS_LABEL[attributes.preRemovalStatus]}`
                  : null,
                attributes.removedByLabel ? `حذف توسط ${attributes.removedByLabel}` : null,
                attributes.purgeAt ? `حذف خودکار: ${formatTehranDate(attributes.purgeAt)}` : null,
              ]
            : [
                view === "scheduled" && attributes.scheduledPublishAt
                  ? `انتشار: ${formatTehranDate(attributes.scheduledPublishAt)} ساعت ${formatTehranTime(attributes.scheduledPublishAt)}`
                  : null,
                attributes.product_main_category?.data?.attributes?.Title || null,
                stock > 0 ? `${faNum(stock)} عدد موجود` : "ناموجود",
              ];

        return (
          <ResourceListItem
            key={row.id}
            href={state === "trashed" ? undefined : `/products/${row.id}`}
            media={<ProductThumbnail row={row} size={56} />}
            title={
              <span
                data-testid="admin-product-row"
                data-product-id={row.id}
                data-product-title={attributes.Title}
              >
                {attributes.Title}
              </span>
            }
            titleSuffix={<span dir="ltr">{sku || "بدون SKU"}</span>}
            badge={<StatusBadge label={badge.label} tone={badge.tone} size="sm" />}
            value={
              state !== "trashed" && price
                ? priceFormatter(price.discount ?? price.price, " تومان")
                : undefined
            }
            meta={meta}
            footer={
              <span>
                {state === "trashed" && attributes.removedAt
                  ? `حذف شده: ${formatFaRelativeDateTime(attributes.removedAt)}`
                  : `آخرین ویرایش: ${formatFaRelativeDateTime(
                      attributes.LastEditedByAdminAt || attributes.updatedAt,
                    )}`}
              </span>
            }
            selection={
              selectionProps?.enableSelection
                ? {
                    checked: selectionProps.selectedIds.has(String(row.id)),
                    onChange: (checked) => selectionProps.onSelectionChange(String(row.id), checked),
                    label: `انتخاب ${attributes.Title}`,
                  }
                : undefined
            }
            actions={renderActions(row)}
          />
        );
      })}
    </ResourceList>
  );
}
