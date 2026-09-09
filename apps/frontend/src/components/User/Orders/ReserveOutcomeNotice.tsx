"use client";

import React from "react";
import Link from "next/link";
import { Clock, Package, Truck } from "lucide-react";
import { faNum } from "@/utils/faNum";
import {
  formatReserveDeadline,
  formatReserveRemaining,
  reserveStateLabel,
} from "@/utils/reserveTime";

export interface ReserveOutcome {
  reserveGroupId?: string | null;
  reserveExpiresAt?: string | null;
  reserveState?: string | null;
  reserveOrderCount?: number;
  /** True when this order joined an existing window instead of opening one. */
  reserveAttached?: boolean;
}

interface Props {
  outcome: ReserveOutcome;
  /** Only confirm a hold once the money is actually taken. */
  isPaid: boolean;
}

/**
 * States the reserve outcome of a just-paid order.
 *
 * Opening a window and joining one are materially different promises -- one pays
 * shipping, the other does not -- so they get different copy rather than a shared
 * "reserve order registered" line. Everything shown comes from the group row, so
 * the deadline is the authoritative one rather than the checkout estimate.
 */
export default function ReserveOutcomeNotice({ outcome, isPaid }: Props) {
  const { reserveGroupId, reserveExpiresAt, reserveState, reserveAttached } = outcome;
  if (!isPaid || !reserveGroupId) return null;

  const isOpen = reserveState === "Active";
  const orderCount = outcome.reserveOrderCount ?? 0;

  return (
    <section
      dir="rtl"
      data-testid="reserve-outcome-notice"
      className="mt-4 flex flex-col gap-3 rounded-panel border border-amber-200 bg-amber-50 p-4 text-right"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
        <Package className="h-4 w-4" />
        {reserveAttached ? "به بسته رزروی شما اضافه شد" : "ارسال رزروی ۴۸ ساعته فعال شد"}
      </h2>

      <p className="text-sm leading-6 text-amber-900">
        {reserveAttached
          ? "این سفارش به بسته رزروی فعال شما اضافه شد و همراه سفارش‌های دیگر همان بسته ارسال می‌شود."
          : "پرداخت شما انجام شد. این سفارش تا پایان مهلت رزرو ارسال نمی‌شود تا بتوانید سفارش‌های بعدی را به همین بسته اضافه کنید."}
      </p>

      <dl className="flex flex-col gap-2 text-sm text-amber-900">
        <div className="flex items-center justify-between gap-2">
          <dt className="flex items-center gap-1.5">
            <Truck className="h-3.5 w-3.5" />
            هزینه ارسال این سفارش
          </dt>
          <dd className="font-medium">
            {reserveAttached ? "۰ تومان" : "با همین سفارش پرداخت شد"}
          </dd>
        </div>

        {orderCount > 0 && (
          <div className="flex items-center justify-between gap-2">
            <dt className="flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5" />
              سفارش‌های این بسته
            </dt>
            <dd className="font-medium">{faNum(orderCount)} سفارش</dd>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <dt className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            وضعیت بسته
          </dt>
          <dd className="font-medium">{reserveStateLabel(reserveState)}</dd>
        </div>

        {isOpen && reserveExpiresAt && (
          <>
            <div className="flex items-center justify-between gap-2">
              <dt>مهلت افزودن سفارش</dt>
              <dd className="font-medium">{formatReserveRemaining(reserveExpiresAt)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt>پایان مهلت</dt>
              <dd className="font-medium">{formatReserveDeadline(reserveExpiresAt)}</dd>
            </div>
          </>
        )}
      </dl>

      <Link
        href={`/orders/reserve/${encodeURIComponent(reserveGroupId)}`}
        prefetch={false}
        className="self-start rounded-control bg-amber-900 px-4 py-2 text-xs font-medium text-white transition hover:bg-amber-800"
      >
        مشاهده بسته رزروی
      </Link>
    </section>
  );
}
