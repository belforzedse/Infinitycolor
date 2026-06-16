import EditIcon from "@/components/SuperAdmin/Layout/Icons/EditIcon";
import SuperAdminTableCellActionButton from "@/components/SuperAdmin/Table/Cells/ActionButton";
import SuperAdminTableCellFullDate from "@/components/SuperAdmin/Table/Cells/FullDate";
import RemoveActionButton from "@/components/SuperAdmin/Table/Cells/RemoveActionButton";
import SuperAdminTableCellSimplePrice from "@/components/SuperAdmin/Table/Cells/SimplePrice";
import SuperAdminTableCellSwitch from "@/components/SuperAdmin/Table/Cells/Switch";
import MobileTableRowBox from "@/components/SuperAdmin/Table/Mobile/Row/Box";
import { priceFormatter } from "@/utils/price";
import type { ColumnDef } from "@tanstack/react-table";

export type Shipping = {
  id: string;
  attributes: {
    Title: string;
    Code?: string;
    Description?: string;
    SortOrder?: number;
    EstimatedDeliveryText?: string;
    Price: number;
    IsActive: boolean;
    removedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
};

export const columns: ColumnDef<Shipping>[] = [
  {
    accessorKey: "attributes.Title",
    header: "روش ارسال",
  },
  {
    accessorKey: "attributes.Code",
    header: "کد",
  },
  {
    accessorKey: "attributes.Price",
    header: "هزینه پایه",
    cell: ({ row }) => {
      const price = row.original?.attributes?.Price as number;
      return <SuperAdminTableCellSimplePrice price={price} />;
    },
  },
  {
    accessorKey: "attributes.SortOrder",
    header: "ترتیب",
  },
  {
    accessorKey: "attributes.EstimatedDeliveryText",
    header: "زمان تحویل",
  },
  {
    accessorKey: "attributes.createdAt",
    header: "تاریخ ایجاد",
    cell: ({ row }) => {
      const date = new Date(row.original?.attributes?.createdAt);
      return <SuperAdminTableCellFullDate date={date} />;
    },
  },
  {
    accessorKey: "attributes.IsActive",
    header: "وضعیت",
    cell: ({ row }) => {
      const status = row.original?.attributes?.IsActive as boolean;
      return (
        <SuperAdminTableCellSwitch
          status={status ? "active" : "inactive"}
          apiUrl={`/shippings/${row.original?.id}`}
        />
      );
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
        <div className="flex flex-row-reverse items-center gap-3 p-1">
          <RemoveActionButton
            apiUrl="/shippings"
            isRemoved={row.original?.attributes?.removedAt !== null}
            id={row.original?.id}
          />

          <SuperAdminTableCellActionButton
            variant="secondary"
            icon={<EditIcon />}
            path={`/super-admin/shipping/edit/${row.original?.id}`}
          />
        </div>
      );
    },
  },
];

type Props = {
  data: Shipping[] | undefined;
};

export const MobileTable = ({ data }: Props) => {
  if (!data) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {data.map((row) => {
        return (
          <MobileTableRowBox
            key={row.id}
            columns={columns}
            row={row}
            header={
              <>
                <div className="flex w-full items-center justify-between rounded-[4px] bg-stone-50 px-2 py-1">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-xs text-neutral-400">
                      {priceFormatter(row?.attributes?.Price, "تومان")}
                    </span>
                    {row?.attributes?.Code && (
                      <>
                        <span className="text-xs text-neutral-400">|</span>
                        <span className="text-xs text-neutral-400">{row.attributes.Code}</span>
                      </>
                    )}
                    <span className="text-xs text-neutral-400">|</span>
                    <span className="text-sm text-neutral-800">
                      {row?.attributes?.IsActive ? "فعال" : "غیرفعال"}
                    </span>
                  </div>

                  <SuperAdminTableCellSwitch
                    status={row?.attributes?.IsActive ? "active" : "inactive"}
                    apiUrl={`/shippings/${row.id}`}
                  />
                </div>
              </>
            }
            headTitle={row?.attributes?.Title}
          />
        );
      })}
    </div>
  );
};
