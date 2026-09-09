import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { priceFormatter } from "@/utils/price";
import {
  formatFaDateTime,
  formatFaRelativeDateTime,
} from "@/utils/formatFaRelativeDateTime";
import {
  CopyableId,
  ResourceList,
  ResourceListItem,
  StatusBadge,
} from "@/components/admin";
import type { AdminReserveGroup } from "@/services/super-admin/orders/reserveGroups";

/** Lifecycle label + tone for a reserve group. */
export function getReserveGroupStatusMeta(group: AdminReserveGroup): {
  label: string;
  tone: "info" | "warning" | "success" | "neutral" | "danger";
} {
  switch (group.state) {
    case "PendingActivation":
      return { label: "در انتظار پرداخت", tone: "neutral" };
    case "Active":
      return group.remainingMs !== null && group.remainingMs <= 6 * 3_600_000
        ? { label: "رو به اتمام", tone: "warning" }
        : { label: "فعال", tone: "info" };
    case "ReadyToFulfill":
      return {
        label:
          group.closureReason === "ReleasedEarly"
            ? "آماده ارسال (آزادسازی زودهنگام)"
            : "آماده ارسال",
        tone: "success",
      };
    case "Fulfilling":
      return { label: "در حال ارسال", tone: "info" };
    case "Completed":
      return { label: "تکمیل‌شده", tone: "success" };
    case "Cancelled":
      return { label: "لغو شده", tone: "danger" };
    default:
      return { label: "نامشخص", tone: "neutral" };
  }
}

/** «۵ ساعت و ۲۰ دقیقه» — remaining time on an open window, else a dash. */
export function formatRemaining(remainingMs: number | null): string {
  if (remainingMs === null || remainingMs <= 0) return "—";
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  const fa = (n: number) => n.toLocaleString("fa-IR");
  return hours > 0 ? `${fa(hours)} ساعت و ${fa(minutes)} دقیقه` : `${fa(minutes)} دقیقه`;
}

export function getReserveGroupCustomer(group: AdminReserveGroup): {
  label: string;
  isPlaceholder: boolean;
  phone: string | null;
} {
  const name = `${group.customer.firstName || ""} ${group.customer.lastName || ""}`.trim();
  const phone = group.customer.phone?.trim() || null;
  if (name) return { label: name, isPlaceholder: false, phone };
  if (phone) return { label: phone, isPlaceholder: false, phone };
  return { label: "بدون مشتری", isPlaceholder: true, phone: null };
}

export const reserveGroupColumns: ColumnDef<AdminReserveGroup>[] = [
  {
    accessorKey: "customer",
    header: "مشتری",
    cell: ({ row }) => {
      const { label, isPlaceholder, phone } = getReserveGroupCustomer(row.original);
      return (
        <div className="flex flex-col gap-0.5">
          <span className={isPlaceholder ? "text-neutral-400" : undefined}>{label}</span>
          {phone && !isPlaceholder && (
            <span className="text-xs text-neutral-500">{phone}</span>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: "groupKey",
    header: "شناسه بسته",
    cell: ({ row }) => (
      <span
        data-testid="admin-reserve-group-row"
        data-group-key={row.original.groupKey}
        data-group-state={row.original.state ?? ""}
      >
        <CopyableId value={row.original.groupKey} label="کپی شناسه بسته رزروی" />
      </span>
    ),
  },
  {
    accessorKey: "rootOrderId",
    header: "سفارش اصلی",
    cell: ({ row }) =>
      row.original.rootOrderId ? (
        <Link
          href={`/orders/edit/${row.original.rootOrderId}`}
          className="text-blue-600 hover:underline"
        >
          #{row.original.rootOrderId}
        </Link>
      ) : (
        <span className="text-neutral-400">—</span>
      ),
  },
  {
    accessorKey: "orderCount",
    header: "سفارش‌ها / اقلام",
    cell: ({ row }) => (
      <span>
        {row.original.orderCount.toLocaleString("fa-IR")} سفارش ·{" "}
        {row.original.itemCount.toLocaleString("fa-IR")} قلم
      </span>
    ),
  },
  {
    accessorKey: "groupValue",
    header: "ارزش بسته",
    cell: ({ row }) => <span>{priceFormatter(row.original.groupValue, " تومان")}</span>,
  },
  {
    accessorKey: "shippingCostPaid",
    header: "ارسال",
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <span>{priceFormatter(row.original.shippingCostPaid, " تومان")}</span>
        <span className="text-xs text-neutral-500">
          {row.original.shippingMethodTitle || "—"}
        </span>
      </div>
    ),
  },
  {
    accessorKey: "destination",
    header: "مقصد",
    cell: ({ row }) => (
      <span className="text-sm">{row.original.destination || "—"}</span>
    ),
  },
  {
    accessorKey: "expiresAt",
    header: "پایان مهلت رزرو",
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <span>{row.original.expiresAt ? formatFaDateTime(row.original.expiresAt) : "—"}</span>
        {row.original.state === "Active" && (
          <span className="text-xs text-amber-700">
            {formatRemaining(row.original.remainingMs)} باقی مانده
          </span>
        )}
      </div>
    ),
  },
  {
    accessorKey: "lastOrderAttachedAt",
    header: "آخرین سفارش اضافه‌شده",
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.lastOrderAttachedAt
          ? formatFaRelativeDateTime(row.original.lastOrderAttachedAt)
          : "—"}
      </span>
    ),
  },
  {
    /*
     * Deliberately «آخرین فعالیت», not the order list's «آخرین ویرایش».
     * Reserve lifecycle transitions are written to the group row by the system,
     * not by staff editing an order, so labelling them as an edit would be a lie.
     */
    accessorKey: "lastActivityAt",
    header: "آخرین فعالیت",
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.lastActivityAt
          ? formatFaRelativeDateTime(row.original.lastActivityAt)
          : "—"}
      </span>
    ),
  },
  {
    accessorKey: "state",
    header: "وضعیت",
    cell: ({ row }) => {
      const meta = getReserveGroupStatusMeta(row.original);
      return <StatusBadge label={meta.label} tone={meta.tone} />;
    },
  },
  {
    accessorKey: "id",
    header: "عملیات",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/orders/reserve/${encodeURIComponent(row.original.groupKey)}`}
        className="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-50"
      >
        مدیریت بسته
      </Link>
    ),
  },
];

type Props = { data: AdminReserveGroup[] | undefined };

export const ReserveGroupsMobileTable = ({ data }: Props) => {
  if (!data) return null;

  return (
    <ResourceList className="mt-2">
      {data.map((group) => {
        const { label, isPlaceholder, phone } = getReserveGroupCustomer(group);
        const meta = getReserveGroupStatusMeta(group);

        return (
          <ResourceListItem
            key={group.groupKey}
            href={`/orders/reserve/${encodeURIComponent(group.groupKey)}`}
            title={
              <span className={isPlaceholder ? "text-neutral-400" : undefined}>{label}</span>
            }
            titleSuffix={
              <span
                data-testid="admin-reserve-group-row"
                data-group-key={group.groupKey}
                data-group-state={group.state ?? ""}
              >
                <CopyableId value={group.groupKey} label="کپی شناسه بسته رزروی" />
              </span>
            }
            badge={<StatusBadge label={meta.label} tone={meta.tone} />}
            value={priceFormatter(group.groupValue, " تومان")}
            meta={[
              phone && !isPlaceholder ? phone : null,
              `${group.orderCount.toLocaleString("fa-IR")} سفارش · ${group.itemCount.toLocaleString("fa-IR")} قلم`,
              group.state === "Active" && group.remainingMs !== null
                ? `${formatRemaining(group.remainingMs)} تا پایان مهلت`
                : group.expiresAt
                  ? `پایان مهلت: ${formatFaDateTime(group.expiresAt)}`
                  : null,
              group.destination,
            ]}
            footer={
              <span>
                آخرین فعالیت: {formatFaRelativeDateTime(group.lastActivityAt)}
              </span>
            }
          />
        );
      })}
    </ResourceList>
  );
};
