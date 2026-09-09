"use client";

import React from "react";
import { Clock, MapPin, Package, Truck } from "lucide-react";
import { faNum } from "@/utils/faNum";
import {
  formatReserveDeadline,
  formatReserveRemaining,
  reserveRemaining,
} from "@/utils/reserveTime";

export type ReserveChoice = "merge" | "new";

export interface ActiveReserveSummary {
  reserveGroupId: string;
  reserveExpiresAt: string | null;
  orderCount: number;
  shippingMethodTitle?: string | null;
  destination?: string | null;
  rootOrderId?: number | null;
}

interface Props {
  reserve: ActiveReserveSummary;
  value: ReserveChoice | null;
  onChange: (choice: ReserveChoice) => void;
  onExpired: () => void;
  disabled?: boolean;
}

/**
 * CASE B -- the customer already has an open 48h window.
 *
 * The real decision is combined vs separate fulfillment, so it is presented as
 * exactly that. The previous UI offered "ثبت سفارش جدید", which described how the
 * record is stored rather than what the shopper is choosing.
 *
 * The countdown is display-only; the backend re-checks eligibility on submit.
 * When it reaches zero we tell the parent so checkout can fall back to normal
 * shipping instead of submitting against a closed window. An *unreadable*
 * deadline is not zero -- see reserveRemaining's isUnknown -- so it hides the
 * countdown and leaves the choice standing.
 */
export default function ReserveFulfillmentChoice({
  reserve,
  value,
  onChange,
  onExpired,
  disabled,
}: Props) {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const remaining = reserveRemaining(reserve.reserveExpiresAt, now);
  const expiredRef = React.useRef(false);

  React.useEffect(() => {
    if (remaining.isExpired && !expiredRef.current) {
      expiredRef.current = true;
      onExpired();
    }
  }, [remaining.isExpired, onExpired]);

  if (remaining.isExpired) return null;

  const isMerge = value === "merge";
  const isSeparate = value === "new";

  return (
    <section
      aria-label="نحوه ارسال این سفارش"
      className="flex flex-col gap-3 rounded-panel border border-infinity-primary-lighter/70 bg-infinity-primary-lighter/20 p-4"
    >
      <header className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-medium text-neutral-900">
          <Package className="h-4 w-4 text-infinity-primary" />
          شما یک سفارش رزروی فعال دارید
        </h3>
        <p className="text-xs leading-5 text-neutral-600">
          می‌توانید این سفارش را به بسته رزروی خود اضافه کنید تا با هم ارسال شوند، یا آن را جداگانه
          بفرستید.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          aria-pressed={isMerge}
          disabled={disabled}
          onClick={() => !disabled && onChange("merge")}
          className={`flex flex-col gap-2 rounded-prominent border p-4 text-right transition disabled:cursor-not-allowed disabled:opacity-60 ${
            isMerge
              ? "border-infinity-primary bg-white ring-1 ring-infinity-primary"
              : "border-slate-200 bg-white/80 hover:border-infinity-primary-lighter"
          }`}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="font-medium text-neutral-900">افزودن به سفارش رزروی فعال</span>
            <span className="rounded-pill bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              ارسال ۰ تومان
            </span>
          </span>

          <span className="flex flex-col gap-1 text-xs leading-5 text-neutral-600">
            <span className="flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5 shrink-0" />
              همراه {faNum(reserve.orderCount)} سفارش موجود در این بسته ارسال می‌شود
              {reserve.rootOrderId ? ` (سفارش #${faNum(reserve.rootOrderId)})` : ""}
            </span>
            {/*
              A deadline we could not read is not a closed window. Drop the
              countdown rather than the whole card -- the shopper keeps the
              choice, and the backend re-checks eligibility on submit anyway.
            */}
            {!remaining.isUnknown && (
              <>
                <span className="flex items-center gap-1.5 text-amber-800">
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  {formatReserveRemaining(reserve.reserveExpiresAt, now)}
                </span>
                <span className="text-neutral-500">
                  مهلت افزودن سفارش تا {formatReserveDeadline(reserve.reserveExpiresAt)}
                </span>
              </>
            )}
          </span>
        </button>

        <button
          type="button"
          aria-pressed={isSeparate}
          disabled={disabled}
          onClick={() => !disabled && onChange("new")}
          className={`flex flex-col gap-2 rounded-prominent border p-4 text-right transition disabled:cursor-not-allowed disabled:opacity-60 ${
            isSeparate
              ? "border-infinity-primary bg-white ring-1 ring-infinity-primary"
              : "border-slate-200 bg-white/80 hover:border-infinity-primary-lighter"
          }`}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="font-medium text-neutral-900">ارسال جداگانه</span>
            <span className="rounded-pill bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              هزینه ارسال عادی
            </span>
          </span>
          <span className="flex flex-col gap-1 text-xs leading-5 text-neutral-600">
            <span className="flex items-center gap-1.5">
              <Truck className="h-3.5 w-3.5 shrink-0" />
              آدرس و روش ارسال را خودتان انتخاب می‌کنید
            </span>
            <span className="text-neutral-500">
              بسته رزروی فعلی شما بدون تغییر باقی می‌ماند.
            </span>
          </span>
        </button>
      </div>

      {isMerge && (
        <div className="flex flex-col gap-2 rounded-control border border-slate-200 bg-white p-3">
          <p className="text-xs font-medium text-neutral-700">
            این سفارش با اطلاعات ارسال بسته رزروی شما فرستاده می‌شود:
          </p>
          <dl className="flex flex-col gap-1.5 text-xs text-neutral-600">
            <div className="flex items-start gap-1.5">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <dt className="sr-only">مقصد</dt>
              <dd>{reserve.destination || "آدرس ثبت‌شده در سفارش رزروی"}</dd>
            </div>
            <div className="flex items-start gap-1.5">
              <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <dt className="sr-only">روش ارسال</dt>
              <dd>{reserve.shippingMethodTitle || "روش ارسال سفارش رزروی"}</dd>
            </div>
          </dl>
          <p className="text-xs leading-5 text-neutral-500">
            برای ارسال به آدرس یا با روش دیگری، گزینه «ارسال جداگانه» را انتخاب کنید.
          </p>
        </div>
      )}
    </section>
  );
}
