"use client";

import { ChevronLeft } from "lucide-react";
import { StatusBadge } from "@/components/admin";
import type {
  RowGroupHeaderProps,
  TableRowGrouping,
} from "@/components/SuperAdmin/Table/rowGrouping";
import ReserveParcelActions from "@/components/SuperAdmin/Order/ReserveParcelActions";
import { faNum } from "@/utils/faNum";
import { getOrderBuyerLabel, type Order } from "./table";

export function ReserveParcelHeader({
  groupKey,
  rows,
  expanded,
  onToggle,
  selection,
}: RowGroupHeaderProps<Order>) {
  const parcel = rows[0].attributes.reserveParcel;
  const label = parcel?.recipientName || getOrderBuyerLabel(rows[0]).label;
  const total = parcel?.orderCount ?? rows.length;
  const count =
    total > rows.length
      ? `${faNum(rows.length)} از ${faNum(total)} سفارش`
      : `${faNum(total)} سفارش`;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 bg-white px-2 py-2.5 md:px-3 lg:px-4"
      data-testid="admin-reserve-parcel"
      data-group-id={groupKey}
    >
      <div className="flex min-w-0 basis-full items-center gap-2 md:flex-1 md:basis-auto">
        {selection && (
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 rounded border-slate-300 accent-infinity-primary"
            aria-label={`انتخاب سفارش‌های این صفحه از بسته ${label}`}
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
          onClick={onToggle}
          aria-label={`${expanded ? "بستن" : "نمایش"} سفارش‌های بسته ${label}`}
          title={label}
          className="flex min-h-9 min-w-0 items-center gap-2 rounded-md text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary"
        >
          <ChevronLeft
            className={`h-4 w-4 shrink-0 text-neutral-500 ${expanded ? "-rotate-90" : ""}`}
            aria-hidden="true"
          />
          <span className="min-w-0 break-words text-sm font-medium leading-6 text-neutral-800">
            {label}
          </span>
        </button>
        <StatusBadge label="رزروی" tone="neutral" size="sm" />
        <span className="shrink-0 text-xs text-neutral-400">{count}</span>
      </div>
      <ReserveParcelActions groupKey={groupKey} parcel={parcel} />
    </div>
  );
}

export const reserveParcelGrouping: TableRowGrouping<Order> = {
  getKey: (order) => order.attributes.reserveGroupId,
  renderHeader: (props) => <ReserveParcelHeader {...props} />,
};
