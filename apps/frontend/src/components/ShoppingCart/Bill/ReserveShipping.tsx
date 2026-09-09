"use client";

import React from "react";
import { Check, Clock, Package, Truck } from "lucide-react";
import { faNum } from "@/utils/faNum";
import { formatReserveDeadline } from "@/utils/reserveTime";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Shipping this order pays, in Toman. Shown so the trade-off is concrete. */
  shippingCost?: number;
}

/**
 * CASE A -- the customer has no open window.
 *
 * Offers the 48h combined-shipping behaviour as a selectable option card rather
 * than an unexplained checkbox: choosing it changes when the parcel ships and how
 * shipping is charged on later orders, which is too consequential to bury.
 */
function ReserveShipping({ checked, onChange, disabled, shippingCost }: Props) {
  // The real deadline is stamped server-side at payment. Before that we can only
  // preview it, so it is labelled as approximate rather than promised.
  const previewDeadline = React.useMemo(
    () => formatReserveDeadline(new Date(Date.now() + 48 * 3_600_000).toISOString()),
    [],
  );

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`w-full rounded-prominent border p-4 text-right transition disabled:cursor-not-allowed disabled:opacity-60 ${
        checked
          ? "border-infinity-primary bg-infinity-primary-lighter/30 ring-1 ring-infinity-primary"
          : "border-slate-200 bg-white hover:border-infinity-primary-lighter"
      }`}
    >
      <span className="flex items-start gap-3">
        <span
          aria-hidden
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-micro border transition ${
            checked
              ? "border-infinity-primary bg-infinity-primary text-white"
              : "border-slate-300 bg-white"
          }`}
        >
          {checked && <Check className="h-3.5 w-3.5" />}
        </span>

        <span className="flex flex-1 flex-col gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <Clock className="h-4 w-4 text-infinity-primary" />
            <span className="font-medium text-neutral-900">ارسال رزروی ۴۸ ساعته</span>
            <span className="rounded-pill bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
              اختیاری
            </span>
          </span>

          <span className="text-sm leading-6 text-neutral-600">
            همین حالا این سفارش را پرداخت می‌کنید و هزینه ارسال آن را می‌پردازید، اما ارسال تا ۴۸
            ساعت انجام نمی‌شود. در این مدت می‌توانید سفارش‌های دیگری ثبت و به همین بسته اضافه کنید؛
            برای آن سفارش‌ها هزینه ارسال گرفته نمی‌شود و همه با هم ارسال می‌شوند.
          </span>

          {checked && (
            <span className="mt-1 flex flex-col gap-1.5 rounded-control bg-white/70 p-3 text-sm">
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-neutral-600">
                  <Truck className="h-3.5 w-3.5" />
                  هزینه ارسال این سفارش
                </span>
                <span className="font-medium text-neutral-900">
                  {typeof shippingCost === "number" ? `${faNum(shippingCost)} تومان` : "—"}
                </span>
              </span>
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-neutral-600">
                  <Package className="h-3.5 w-3.5" />
                  هزینه ارسال سفارش‌های بعدی
                </span>
                <span className="font-medium text-emerald-700">۰ تومان</span>
              </span>
              <span className="mt-1 text-xs leading-5 text-neutral-500">
                مهلت افزودن سفارش، حدوداً تا {previewDeadline}. زمان دقیق پس از پرداخت موفق مشخص
                می‌شود.
              </span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

export default ReserveShipping;
