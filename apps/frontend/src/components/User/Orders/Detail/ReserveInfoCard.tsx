"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Clock, Package } from "lucide-react";
import OrderService from "@/services/order";
import type { Order } from "@/services/order";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import {
  formatReserveDeadline,
  formatReserveRemaining,
  reserveStateLabel,
} from "@/utils/reserveTime";
import toast from "react-hot-toast";

interface Props {
  order: Order;
  onReleased?: () => void;
}

/**
 * Reserve status on the order-detail page.
 *
 * Reads the server projection (`reserveIsActive`), not the order's frozen
 * `reserveExpiresAt` column, so a closed group shows its outcome rather than a
 * stale countdown. Closed groups still render -- the history of why several
 * orders shipped together outlives the window.
 */
export default function ReserveInfoCard({ order, onReleased }: Props) {
  const [isReleasing, setIsReleasing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [, setTick] = useState(0);

  const isActive = Boolean(order.reserveIsActive);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [isActive]);

  const handleRelease = useCallback(async () => {
    try {
      setIsReleasing(true);
      await OrderService.releaseReserve(order.id);
      toast.success("سفارش شما برای ارسال آماده شد");
      setConfirmOpen(false);
      onReleased?.();
    } catch {
      toast.error("خطا در به‌روزرسانی. لطفاً دوباره تلاش کنید.");
    } finally {
      setIsReleasing(false);
    }
  }, [order.id, onReleased]);

  if (!order.isReserveOrder) return null;

  const tone = isActive
    ? "border-amber-200 bg-amber-50/50"
    : "border-slate-200 bg-slate-50";

  return (
    <div className={`rounded-2xl border p-4 ${tone}`} data-testid="reserve-info-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2">
          {isActive ? (
            <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          ) : (
            <Package className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
          )}
          <div className="flex flex-col gap-0.5">
            <p className={`font-medium ${isActive ? "text-amber-900" : "text-slate-800"}`}>
              ارسال رزروی
            </p>
            {isActive ? (
              <>
                <p className="text-sm text-amber-800">
                  مهلت افزودن سفارش: {formatReserveRemaining(order.reserveExpiresAt)}
                </p>
                <p className="text-xs text-amber-700">
                  پایان مهلت: {formatReserveDeadline(order.reserveExpiresAt)}
                </p>
              </>
            ) : (
              <p className="text-sm text-slate-600">
                {reserveStateLabel(order.reserveState, order.reserveClosureReason)}
              </p>
            )}
            {order.reserveGroupId && (
              <Link
                href={`/orders/reserve/${encodeURIComponent(order.reserveGroupId)}`}
                prefetch={false}
                className="text-xs text-infinity-primary hover:underline"
              >
                مشاهده بسته رزروی
              </Link>
            )}
          </div>
        </div>

        {isActive && (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={isReleasing}
            className="shrink-0 rounded-lg border border-infinity-primary-lighter/60 bg-white px-4 py-2 text-sm font-medium text-infinity-primary transition hover:bg-infinity-primary-lighter/20 disabled:opacity-50"
          >
            {isReleasing ? "در حال پردازش..." : "ارسال الان"}
          </button>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmOpen}
        title="ارسال زودهنگام بسته رزروی"
        description="با این کار مهلت رزرو بسته می‌شود و پس از آن نمی‌توانید سفارش دیگری به این بسته اضافه کنید. سفارش‌های فعلی برای ارسال آماده می‌شوند. این عمل قابل بازگشت نیست."
        confirmText={isReleasing ? "در حال پردازش..." : "بله، همین حالا ارسال شود"}
        cancelText="انصراف"
        confirmDisabled={isReleasing}
        onConfirm={handleRelease}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
