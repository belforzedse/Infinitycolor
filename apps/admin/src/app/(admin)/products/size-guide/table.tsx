"use client";

import SuperAdminTableCellFullDate from "@/components/SuperAdmin/Table/Cells/FullDate";
import type { ColumnDef } from "@tanstack/react-table";

export type SizeHelper = {
  id: string;
  attributes: {
    createdAt?: string;
    product?: {
      data?: {
        id?: number;
        attributes?: {
          Title?: string;
        };
      } | null;
    };
  };
};

const productTitleOf = (row: SizeHelper | undefined) =>
  row?.attributes?.product?.data?.attributes?.Title || "-";

export const columns: ColumnDef<SizeHelper>[] = [
  {
    accessorKey: "attributes.product.data.attributes.Title",
    header: "محصول",
    cell: ({ row }) => (
      <span className="text-xs text-foreground-primary md:text-base">
        {productTitleOf(row.original)}
      </span>
    ),
  },
  {
    accessorKey: "attributes.createdAt",
    header: "تاریخ ایجاد",
    cell: ({ row }) => {
      const date = row.original?.attributes?.createdAt as unknown as Date;
      return <SuperAdminTableCellFullDate date={date} />;
    },
  },
];

type Props = {
  data: SizeHelper[] | undefined;
};

export const MobileTable = ({ data }: Props) => {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {data?.map((row) => (
        <div
          key={row.id}
          className="flex min-h-[76px] w-full items-center gap-2 rounded-lg bg-white p-3"
        >
          <div className="flex flex-1 flex-col gap-2">
            <div className="flex w-full items-center justify-between">
              <span className="text-sm text-neutral-800">{productTitleOf(row)}</span>
            </div>

            <div className="flex w-full items-center justify-between rounded-[4px] bg-stone-50 px-2 py-1">
              <span className="text-xs text-neutral-400">
                {row.attributes?.createdAt
                  ? new Date(row.attributes.createdAt).toLocaleDateString("fa-IR")
                  : ""}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
