import SuperAdminTableCellFullDate from "@/components/SuperAdmin/Table/Cells/FullDate";
import SuperAdminTableCellFullDateTime from "@/components/SuperAdmin/Table/Cells/FullDateTime";
import { priceFormatter } from "@/utils/price";
import SuperAdminTableCellSimplePrice from "@/components/SuperAdmin/Table/Cells/SimplePrice";
import type { ColumnDef } from "@tanstack/react-table";
import OrderRowActions from "@/components/SuperAdmin/Order/OrderRowActions";
import { getOrderStatusMeta } from "@/utils/statusTranslations";
import { formatFaRelativeDateTime } from "@/utils/formatFaRelativeDateTime";
import {
  CopyableId,
  ResourceList,
  ResourceListItem,
  StatusBadge,
} from "@/components/admin";
import type { AnipoBarcodeState } from "@/types/super-admin/order";
/**
 * Identity shown on an order row.
 *
 * The list is a fulfilment surface, so the primary name is the shipping
 * recipient (`delivery_address.FullName`), not the account profile. Account
 * name is only a fallback when the address has no recipient — manual orders
 * and older rows. Orders with nobody attached at all are labelled honestly,
 * and a missing name still falls back to the phone.
 */
export function getOrderBuyer(order: Order): {
  name: string | null;
  phone: string | null;
  isManual: boolean;
} {
  const user = order?.attributes?.user?.data?.attributes;
  const info = user?.user_info?.data?.attributes;
  const shippingName = order?.attributes?.recipientName?.trim() || "";
  const accountName = `${info?.FirstName || ""} ${info?.LastName || ""}`.trim();
  const name = shippingName || accountName;
  const phone = user?.Phone?.trim() || null;
  const isManual = !order?.attributes?.contract?.data?.attributes?.Amount;

  return { name: name || null, phone, isManual };
}

/** The label to show as the row's primary title. */
export function getOrderBuyerLabel(order: Order): {
  label: string;
  isPlaceholder: boolean;
} {
  const { name, phone, isManual } = getOrderBuyer(order);
  if (name) return { label: name, isPlaceholder: false };
  if (phone) return { label: phone, isPlaceholder: false };
  if (isManual) return { label: "سفارش دستی", isPlaceholder: true };
  return { label: "بدون مشتری", isPlaceholder: true };
}

export type Order = {
  id: string;
  attributes: {
    Description: string;
    Note: string;
    Status: string;
    Date: string;
    ShippingMethodCode?: string;
    ShippingBarcode?: string;
    /** Shipping recipient. Preferred over the account profile on this list. */
    recipientName?: string | null;
    ShippingWeight?: number;
    ShippingBoxSizeId?: number;
    AnipoBarcodeState?: AnipoBarcodeState;
    AnipoSubmittedAt?: string;
    AnipoLastCheckedAt?: string;
    AnipoPollingDeadlineAt?: string;
    AnipoIssuedAt?: string;
    AnipoReadyToIssue?: boolean;
    AnipoProviderStatus?: string;
    AnipoLastMessage?: string;
    AnipoLastError?: string;
    /**
     * Projected from the reserve group by the list endpoint, not read from the
     * order's frozen reserve columns. `reserveIsHeld` means the API refuses
     * shipment actions on this order until the window closes.
     */
    isReserveOrder?: boolean;
    reserveGroupId?: string | null;
    reserveState?: string | null;
    reserveClosureReason?: string | null;
    reserveExpiresAt?: string | null;
    reserveIsActive?: boolean;
    reserveIsHeld?: boolean;
    createdAt: string;
    updatedAt: string;
    user: {
      data: {
        id: number;
        attributes: {
          Phone: string;
          IsVerified: boolean;
          createdAt: string;
          updatedAt: string;
          IsActive: boolean;
          removedAt: string | null;
          user_info: {
            data: {
              id: number;
              attributes: {
                FirstName: string;
                LastName: string;
                createdAt: string;
                updatedAt: string;
                NationalCode: string;
                BirthDate: string;
                Sex: boolean;
                Bio: string;
              };
            };
          };
        };
      };
    };
    contract: {
      data: {
        id: number;
        attributes: {
          Type: string;
          Status: string;
          Amount: number;
          TaxPercent: number;
          Date: string;
          createdAt: string;
          updatedAt: string;
        };
      };
    };
  };
};
export const bulkPrintOrders = (selectedIds: string[]) => {
  if (!selectedIds.length) return;
  const url = `/orders/print/bulk?ids=${selectedIds.join(",")}`;
  window.open(url, "_blank"); // ✅ One tab only
};

export const columns: ColumnDef<Order>[] = [
  {
    accessorKey: "attributes.user.data.attributes.Phone",
    header: "مشتری",
    cell: ({ row }) => {
      const { label, isPlaceholder } = getOrderBuyerLabel(row.original);
      return (
        <span
          className={
            isPlaceholder
              ? "text-sm text-neutral-400"
              : "text-sm font-medium text-foreground-primary"
          }
        >
          {label}
        </span>
      );
    },
  },
  {
    accessorKey: "id",
    header: "سفارش",
    cell: ({ row }) => {
      return (
        <span
          data-testid="admin-order-row"
          data-order-id={row.original.id}
          data-order-status={row.original.attributes.Status}
        >
          <CopyableId value={row.original.id} label="کپی شماره سفارش" />
        </span>
      );
    },
  },
  {
    accessorKey: "attributes.Date",
    header: "تاریخ",
    cell: ({ row }) => {
      const date = new Date(row.original?.attributes?.Date);

      return <DateAgo date={date} />;
    },
  },
  {
    accessorKey: "attributes.updatedAt",
    header: "آخرین ویرایش",
    cell: ({ row }) => {
      const updatedAt = row.original?.attributes?.updatedAt;
      if (!updatedAt) return "-";
      return <SuperAdminTableCellFullDateTime date={new Date(updatedAt)} />;
    },
  },
  {
    accessorKey: "status",
    header: "وضعیت",
    cell: ({ row }) => {
      if (row.original.attributes.reserveIsHeld) {
        const statusMeta = getOrderStatusMeta(row.original.attributes.Status);
        return (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge label={statusMeta.label} tone={statusMeta.tone} />
            <span
              data-testid="admin-order-reserve-hold"
              className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 ring-1 ring-amber-600/20"
            >
              در مهلت رزرو — ارسال متوقف
            </span>
          </div>
        );
      }
      const status = row.original?.attributes?.Status;
      const meta = getOrderStatusMeta(status);

      return <StatusBadge label={meta.label} tone={meta.tone} />;
    },
  },
  {
    accessorKey: "price",
    header: "مجموع",
    cell: ({ row }) => {
      const price = row.original?.attributes?.contract?.data?.attributes?.Amount;

      return price ? (
        <SuperAdminTableCellSimplePrice price={price} />
      ) : (
        <span className="text-sm text-foreground-primary">سفارش دستی</span>
      );
    },
  },
  {
    accessorKey: "attributes.ShippingBarcode",
    header: "کد رهگیری",
    cell: ({ row }) => {
      const barcode = row.original?.attributes?.ShippingBarcode;

      return <span className="text-sm text-foreground-primary">{barcode || "-"}</span>;
    },
  },
  {
    accessorKey: "createdAt",
    header: "عملیات",
    meta: {
      headerClassName: "text-left",
      cellClassName: "text-left",
    },
    cell: ({ row }) => {
      return (
        <OrderRowActions
          orderId={row.original.id}
          orderStatus={row.original.attributes.Status}
          shippingMethodCode={row.original.attributes.ShippingMethodCode}
          shippingBarcode={row.original.attributes.ShippingBarcode}
          shippingWeight={row.original.attributes.ShippingWeight}
          shippingBoxSizeId={row.original.attributes.ShippingBoxSizeId}
          anipoBarcodeState={row.original.attributes.AnipoBarcodeState}
          anipoLastMessage={row.original.attributes.AnipoLastMessage}
          anipoLastError={row.original.attributes.AnipoLastError}
          reserveIsHeld={row.original.attributes.reserveIsHeld}
        />
      );
    },
  },
];

function DateAgo(props: { date: Date }) {
  const { date } = props;

  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return (
      <span className="text-xs text-neutral-400 md:text-base md:text-foreground-primary">
        {diffInSeconds} ثانیه پیش
      </span>
    );
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return (
      <span className="text-xs text-neutral-400 md:text-base md:text-foreground-primary">
        {diffInMinutes} دقیقه پیش
      </span>
    );
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 12) {
    return (
      <span className="text-xs text-neutral-400 md:text-base md:text-foreground-primary">
        {diffInHours} ساعت پیش
      </span>
    );
  }

  return <SuperAdminTableCellFullDate date={date} />;
}

type Props = {
  data: Order[] | undefined;
  selectionProps?: {
    enableSelection: boolean;
    selectedIds: Set<string>;
    onSelectionChange: (id: string, selected: boolean) => void;
  };
};

/**
 * Compact-width orders list.
 *
 * The shipping recipient is the title because that is the name on the parcel;
 * the order number stays immediately available and copyable underneath, since
 * it is what they quote to customers and search by. This replaces a single
 * unwrapped flex row that crammed phone | date | edited | status | barcode
 * behind a 24px expand chevron and overflowed on any real phone.
 */
export const MobileTable = ({ data, selectionProps }: Props) => {
  if (!data) return null;

  return (
    <ResourceList className="mt-2">
      {data.map((row) => {
        const { label, isPlaceholder } = getOrderBuyerLabel(row);
        const { phone } = getOrderBuyer(row);
        const statusMeta = getOrderStatusMeta(row?.attributes?.Status);
        const amount = row?.attributes?.contract?.data?.attributes?.Amount;
        const barcode = row?.attributes?.ShippingBarcode;

        return (
          <ResourceListItem
            key={row.id}
            href={`/orders/edit/${row.id}`}
            title={
              <span className={isPlaceholder ? "text-neutral-400" : undefined}>
                {label}
              </span>
            }
            titleSuffix={
              <span
                data-testid="admin-order-row"
                data-order-id={row.id}
                data-order-status={row.attributes.Status}
              >
                <CopyableId value={row.id} label="کپی شماره سفارش" />
              </span>
            }
            badge={<StatusBadge label={statusMeta.label} tone={statusMeta.tone} />}
            value={
              amount ? priceFormatter(amount, " تومان") : "سفارش دستی"
            }
            meta={[
              phone && !isPlaceholder ? phone : null,
              <DateAgo key="date" date={new Date(row?.attributes?.Date)} />,
              barcode ? `رهگیری: ${barcode}` : null,
              row?.attributes?.reserveIsHeld ? "در مهلت رزرو — ارسال متوقف" : null,
            ]}
            footer={
              <span>
                آخرین ویرایش: {formatFaRelativeDateTime(row?.attributes?.updatedAt)}
              </span>
            }
            selection={
              selectionProps?.enableSelection
                ? {
                    checked: selectionProps.selectedIds.has(row.id),
                    onChange: (checked) =>
                      selectionProps.onSelectionChange(row.id, checked),
                    label: `انتخاب سفارش ${row.id}`,
                  }
                : undefined
            }
            actions={
              <OrderRowActions
                orderId={row.id}
                orderStatus={row.attributes.Status}
                shippingMethodCode={row.attributes.ShippingMethodCode}
                shippingBarcode={row.attributes.ShippingBarcode}
                shippingWeight={row.attributes.ShippingWeight}
                shippingBoxSizeId={row.attributes.ShippingBoxSizeId}
                anipoBarcodeState={row.attributes.AnipoBarcodeState}
                anipoLastMessage={row.attributes.AnipoLastMessage}
                anipoLastError={row.attributes.AnipoLastError}
                reserveIsHeld={row.attributes.reserveIsHeld}
              />
            }
          />
        );
      })}
    </ResourceList>
  );
};
