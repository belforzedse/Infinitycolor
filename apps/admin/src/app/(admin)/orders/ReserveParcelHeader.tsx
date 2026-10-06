"use client";

import Link from "next/link";
import { ChevronDown, Package, Printer } from "lucide-react";
import { CopyableId, StatusBadge } from "@/components/admin";
import type {
  RowGroupHeaderProps,
  TableRowGrouping,
} from "@/components/SuperAdmin/Table/rowGrouping";
import { useCan } from "@/hooks/useCan";
import { faNum } from "@/utils/faNum";
import { getOrderBuyerLabel, type Order } from "./table";

export function ReserveParcelHeader({
  groupKey,
  rows,
  expanded,
  onToggle,
  selection,
}: RowGroupHeaderProps<Order>) {
  const canPrint = useCan("order.print");
  const { label } = getOrderBuyerLabel(rows[0]);
  const groupPath = encodeURIComponent(groupKey);

  return (
    <div
      className="flex flex-wrap items-center gap-3 p-3 text-right"
      data-testid="admin-reserve-parcel"
      data-group-id={groupKey}
    >
      <div className="flex w-full min-w-0 items-center gap-3 lg:w-auto lg:flex-1">
        {selection && (
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-infinity-primary"
            aria-label={`انتخاب سفارش‌های این صفحه از بسته ${groupKey}`}
            checked={selection.checked}
            ref={(element) => {
              if (element) element.indeterminate = selection.indeterminate;
            }}
            onChange={(event) => selection.onChange(event.target.checked)}
          />
        )}
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "بستن" : "نمایش"} سفارش‌های بسته ${groupKey}`}
          onClick={onToggle}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary"
        >
          <Package
            className="h-5 w-5 shrink-0 text-infinity-primary"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-semibold text-foreground-primary">
              بسته رزروی · {label}
            </span>
            <span className="text-xs text-neutral-500">
              {faNum(rows.length)} سفارش در این صفحه
            </span>
          </span>
          <ChevronDown
            className={`h-5 w-5 shrink-0 text-infinity-primary ${expanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      </div>
      <CopyableId
        value={groupKey}
        label="کپی شناسه بسته"
        className="min-h-11 max-w-full [&>span]:min-w-0 [&>span]:truncate"
      />
      {rows.some((row) => row.attributes.reserveIsHeld) && (
        <StatusBadge label="در مهلت رزرو" tone="warning" />
      )}
      <div className="flex w-full flex-wrap items-center justify-end gap-2 lg:w-auto">
        <Link
          href={`/orders/reserve/${groupPath}`}
          className="inline-flex min-h-11 items-center rounded-lg px-3 text-xs font-medium text-infinity-primary hover:bg-infinity-primary/10"
        >
          جزئیات بسته
        </Link>
        {canPrint && (
          <Link
            href={`/orders/print/reserve/${groupPath}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-infinity-primary/20 bg-white px-3 text-xs font-semibold text-infinity-primary hover:bg-infinity-primary/10"
          >
            <Printer className="h-4 w-4 shrink-0" aria-hidden="true" />
            چاپ فاکتور کل بسته
          </Link>
        )}
      </div>
    </div>
  );
}

export const reserveParcelGrouping: TableRowGrouping<Order> = {
  getKey: (order) => order.attributes.reserveGroupId,
  renderHeader: (props) => <ReserveParcelHeader {...props} />,
};
