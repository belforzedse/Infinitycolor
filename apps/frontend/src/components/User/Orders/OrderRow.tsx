import { useEffect, useState } from "react";
import Image from "next/image";
import imageLoader from "@/utils/imageLoader";
import Link from "next/link";
import CancelIcon from "../Icons/CancelIcon";
import TickIcon from "../Icons/TickIcon";
import { PersianOrderStatus } from "@/constants/enums";
import clsx from "clsx";
import ReserveChip from "./ReserveChip";
import PaymentStatusButton from "./PaymentStatusButton";
import ShowFactorButton from "./ShowFactorButton";
import { Eye, Clock } from "lucide-react";

interface Props {
  image: string;
  category: string;
  date: string;
  time: string;
  price: string;
  status: PersianOrderStatus;
  title: string;
  orderId?: number;
  shippingBarcode?: string;
  detailHref: string;
  onViewDetails: () => void;
  onOpenFullDetails?: () => void;
  isReserveOrder?: boolean;
  reserveExpiresAt?: string | null;
  reserveState?: string | null;
  reserveClosureReason?: string | null;
  reserveIsActive?: boolean;
  reserveGroupOrderCount?: number;
  onReleaseReserve?: (orderId: number) => void;
  isReleasingReserve?: boolean;
}

export default function OrderRow({
  image,
  category,
  date,
  time,
  price,
  status,
  title,
  orderId,
  shippingBarcode,
  detailHref,
  onViewDetails,
  onOpenFullDetails,
  isReserveOrder,
  reserveExpiresAt,
  reserveState,
  reserveClosureReason,
  reserveIsActive,
  reserveGroupOrderCount,
  onReleaseReserve,
  isReleasingReserve,
}: Props) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="py-3 pl-4">
        <div className="flex items-center gap-1">
          <div className="relative h-12 w-12 overflow-hidden rounded-lg border border-gray-200">
            {image ? (
              <Image
                src={image}
                alt={title}
                fill
                sizes="48px"
                className="h-full w-full object-cover"
                loader={imageLoader}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gray-100">
                <span className="text-xs text-gray-400">تصویر</span>
              </div>
            )}
          </div>
          <span className="text-xs text-neutral-800">{title}</span>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-neutral-800">{category}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-neutral-800">
          {time} - {date}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-neutral-800">{price} تومان</span>
      </td>
      <td className="min-w-44 px-4 py-3">
        <div className="flex items-center gap-2">
          <div
            className={clsx(
              "flex h-6 w-6 items-center justify-center rounded-full",
              status === PersianOrderStatus.CANCELLED && "bg-red-500",
              status === PersianOrderStatus.INPROGRESS && "bg-yellow-500",
              status === PersianOrderStatus.DELIVERED && "bg-green-500",
            )}
          >
            {status === PersianOrderStatus.CANCELLED ? <CancelIcon /> : <TickIcon />}
          </div>
          <span className="text-sm text-gray-700">{status}</span>
        </div>
      </td>
      <td className="w-fit py-3 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <ReserveChip
            isReserveOrder={isReserveOrder}
            reserveExpiresAt={reserveExpiresAt}
            reserveState={reserveState}
            reserveClosureReason={reserveClosureReason}
            reserveIsActive={reserveIsActive}
            groupOrderCount={reserveGroupOrderCount}
          />
          {reserveIsActive && orderId && onReleaseReserve && (
            <button
              type="button"
              onClick={() => onReleaseReserve(orderId)}
              disabled={isReleasingReserve}
              className="text-xs rounded-lg border border-infinity-primary-lighter/60 px-2 py-1 text-infinity-primary transition hover:bg-infinity-primary-lighter/20 disabled:opacity-50"
            >
              {isReleasingReserve ? "در حال پردازش..." : "ارسال الان"}
            </button>
          )}
          {orderId && <PaymentStatusButton orderId={orderId} />}
          {shippingBarcode ? (
            <a
              href={`https://anipo.ir/checkconsignment/?code=${shippingBarcode}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs rounded-lg bg-blue-50 px-2 py-1 text-blue-700 transition-colors hover:bg-blue-100"
            >
              رهگیری مرسوله
            </a>
          ) : null}
          <button
            type="button"
            onClick={onViewDetails}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-infinity-primary-lighter/60 hover:text-infinity-primary"
          >
            <Eye className="h-4 w-4" />
            <span>جزئیات</span>
          </button>
          <Link
            href={detailHref}
            prefetch={false}
            onClick={onOpenFullDetails}
            className="text-xs rounded-lg border border-infinity-primary-lighter/40 px-2 py-1 text-infinity-primary transition hover:bg-infinity-primary-lighter/20"
          >
            مشاهده کامل
          </Link>
          <ShowFactorButton />
        </div>
      </td>
    </tr>
  );
}
