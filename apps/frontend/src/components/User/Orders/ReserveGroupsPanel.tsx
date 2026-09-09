"use client";

import React from "react";
import Link from "next/link";
import { Clock, MapPin, Package, Truck } from "lucide-react";
import OrderService from "@/services/order";
import type { CustomerReserveGroup } from "@/services/order/reserve";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import OrderCardSkeleton from "./OrderCardSkeleton";
import { faNum } from "@/utils/faNum";
import {
  formatReserveDeadline,
  formatReserveRemaining,
  reserveStateLabel,
} from "@/utils/reserveTime";
import { formatFaDateTime } from "@/utils/formatFaRelativeDateTime";
import toast from "react-hot-toast";

/**
 * The `سفارش‌های رزروی` tab.
 *
 * Sourced from the group endpoint rather than by grouping the visible order page.
 * A group is a durable record: synthesising one from whichever member orders
 * happen to be on the current page would make a completed combined shipment
 * vanish as its orders aged out of view.
 */
export default function ReserveGroupsPanel() {
  const [groups, setGroups] = React.useState<CustomerReserveGroup[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [releasing, setReleasing] = React.useState(false);
  const [confirmGroup, setConfirmGroup] = React.useState<CustomerReserveGroup | null>(null);
  const [, setTick] = React.useState(0);

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      const response = await OrderService.getMyReserveGroups(1, 50);
      setGroups(response.data ?? []);
    } catch (err) {
      console.error("Error fetching reserve groups:", err);
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const hasActive = groups.some((g) => g.isActive);
  React.useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [hasActive]);

  /**
   * Early release is a per-group action but the endpoint is addressed by one of
   * its orders, which is why the root order id is carried on the group.
   */
  const handleRelease = React.useCallback(async () => {
    if (!confirmGroup?.rootOrderId) return;
    try {
      setReleasing(true);
      await OrderService.releaseReserve(confirmGroup.rootOrderId);
      toast.success("بسته رزروی شما برای ارسال آماده شد");
      setConfirmGroup(null);
      await load();
    } catch {
      toast.error("خطا در به‌روزرسانی. لطفاً دوباره تلاش کنید.");
    } finally {
      setReleasing(false);
    }
  }, [confirmGroup, load]);

  if (loading && groups.length === 0) {
    return (
      <div className="w-full">
        {Array.from({ length: 2 }).map((_, i) => (
          <OrderCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-lg bg-gray-50 p-8 text-center">
        <p className="text-gray-600">هنوز سفارش رزروی ثبت نکرده‌اید.</p>
        <p className="mt-2 text-sm text-gray-500">
          هنگام تسویه می‌توانید «ارسال رزروی ۴۸ ساعته» را انتخاب کنید تا سفارش‌های بعدی بدون هزینه
          ارسال به همین بسته اضافه شوند.
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3" data-testid="reserve-groups-panel">
      {groups.map((group) => (
        <article
          key={group.reserveGroupId}
          data-testid="reserve-group-card"
          className={`flex flex-col gap-3 rounded-2xl border p-4 ${
            group.isActive ? "border-amber-200 bg-amber-50/40" : "border-slate-200 bg-white"
          }`}
        >
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium text-neutral-900">
              <Package className="h-4 w-4 text-infinity-primary" />
              بسته رزروی {faNum(group.orderCount)} سفارشی
            </h3>
            <span
              className={`rounded-pill px-2.5 py-1 text-xs ${
                group.isActive ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-700"
              }`}
            >
              {reserveStateLabel(group.state, group.closureReason)}
            </span>
          </header>

          <dl className="grid gap-2 text-xs text-neutral-600 sm:grid-cols-2">
            {group.isActive ? (
              <>
                <div className="flex items-center gap-1.5 text-amber-800">
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  <dt className="sr-only">مهلت افزودن سفارش</dt>
                  <dd>{formatReserveRemaining(group.expiresAt)}</dd>
                </div>
                <div>
                  <dt className="inline">پایان مهلت رزرو: </dt>
                  <dd className="inline">{formatReserveDeadline(group.expiresAt)}</dd>
                </div>
              </>
            ) : (
              group.closedAt && (
                <div>
                  <dt className="inline">پایان مهلت رزرو: </dt>
                  <dd className="inline">{formatFaDateTime(group.closedAt)}</dd>
                </div>
              )
            )}

            <div className="flex items-center gap-1.5">
              <Truck className="h-3.5 w-3.5 shrink-0" />
              <dt className="sr-only">روش ارسال</dt>
              <dd>
                {group.shippingMethodTitle || "روش ارسال ثبت‌شده"} —{" "}
                {group.shippingCostPaid > 0
                  ? `${faNum(group.shippingCostPaid)} تومان (یک‌بار پرداخت شد)`
                  : "هزینه ارسال پرداخت‌شده"}
              </dd>
            </div>

            {group.destination && (
              <div className="flex items-start gap-1.5">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <dt className="sr-only">مقصد</dt>
                <dd className="line-clamp-2">{group.destination}</dd>
              </div>
            )}

            {group.lastOrderAttachedAt && (
              <div>
                <dt className="inline">آخرین سفارش اضافه‌شده: </dt>
                <dd className="inline">{formatFaDateTime(group.lastOrderAttachedAt)}</dd>
              </div>
            )}

            {group.shippingBarcode && (
              <div>
                <dt className="inline">کد رهگیری مرسوله: </dt>
                <dd className="inline font-medium text-neutral-800">{group.shippingBarcode}</dd>
              </div>
            )}
          </dl>

          <footer className="flex flex-wrap items-center gap-2">
            <Link
              href={`/orders/reserve/${encodeURIComponent(group.reserveGroupId)}`}
              prefetch={false}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700 transition hover:border-infinity-primary-lighter/60 hover:text-infinity-primary"
            >
              مشاهده سفارش‌های این بسته
            </Link>
            {group.isActive && group.rootOrderId && (
              <button
                type="button"
                onClick={() => setConfirmGroup(group)}
                className="rounded-lg border border-infinity-primary-lighter/60 px-3 py-1.5 text-xs text-infinity-primary transition hover:bg-infinity-primary-lighter/20"
              >
                ارسال الان
              </button>
            )}
          </footer>
        </article>
      ))}

      <ConfirmDialog
        isOpen={Boolean(confirmGroup)}
        title="ارسال زودهنگام بسته رزروی"
        description="با این کار مهلت رزرو بسته می‌شود و پس از آن نمی‌توانید سفارش دیگری به این بسته اضافه کنید. سفارش‌های فعلی برای ارسال آماده می‌شوند. این عمل قابل بازگشت نیست."
        confirmText={releasing ? "در حال پردازش..." : "بله، همین حالا ارسال شود"}
        cancelText="انصراف"
        confirmDisabled={releasing}
        onConfirm={handleRelease}
        onCancel={() => setConfirmGroup(null)}
      />
    </div>
  );
}
