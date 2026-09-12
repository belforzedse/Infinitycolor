"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import UserContainer from "@/components/layout/UserContainer";
import OrderRow from "@/components/User/Orders/OrderRow";
import OrderCard from "@/components/User/Orders/OrderCard";
import OrderCardSkeleton from "@/components/User/Orders/OrderCardSkeleton";
import OrderRowSkeleton from "@/components/User/Orders/OrderRowSkeleton";
import OrderDetailsDrawer from "@/components/User/Orders/OrderDetailsDrawer";
import OrderService from "@/services/order";
import type { Order } from "@/services/order";
import type { CustomerReserveGroup } from "@/services/order/reserve";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import { faNum } from "@/utils/faNum";
import { IMAGE_BASE_URL, PLACEHOLDER_IMAGE } from "@/utils/orderDisplayConstants";
import {
  formatOrderDate,
  formatOrderTime,
  mapOrderToDisplayProps,
  persistOrderSnapshot,
} from "@/utils/orderDisplayHelpers";
import { ChevronRight, Clock, MapPin, Package, Truck } from "lucide-react";
import {
  formatReserveDeadline,
  formatReserveRemaining,
  reserveStateLabel,
} from "@/utils/reserveTime";
import { formatFaDateTime } from "@/utils/formatFaRelativeDateTime";
import toast from "react-hot-toast";
import { StorefrontAccountShell } from "@/components/storefront/StorefrontAccountShell";

export default function ReserveGroupPage() {
  const params = useParams();
  const reserveGroupId = typeof params?.reserveGroupId === "string" ? params.reserveGroupId : null;
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [releasingOrderId, setReleasingOrderId] = useState<number | null>(null);
  const [group, setGroup] = useState<CustomerReserveGroup | null>(null);
  const [confirmReleaseOrderId, setConfirmReleaseOrderId] = useState<number | null>(null);

  const RESERVE_GROUP_PAGE_SIZE = 100;

  const loadOrders = useCallback(async () => {
    if (!reserveGroupId) return;
    try {
      setLoading(true);
      // The group row owns the lifecycle; member orders alone cannot say whether
      // the window is still open or why it closed.
      OrderService.getMyReserveGroup(reserveGroupId)
        .then((res) => setGroup(res.data ?? null))
        .catch(() => setGroup(null));

      const first = await OrderService.getMyOrders(1, RESERVE_GROUP_PAGE_SIZE, { reserveGroupId });
      const pageCount = first.meta?.pagination?.pageCount ?? 1;
      if (pageCount <= 1) {
        setOrders(first.data);
        return;
      }
      const all: Order[] = [...first.data];
      for (let p = 2; p <= pageCount; p++) {
        const next = await OrderService.getMyOrders(p, RESERVE_GROUP_PAGE_SIZE, { reserveGroupId });
        all.push(...next.data);
      }
      setOrders(all);
    } catch (err) {
      console.error("Error fetching reserve group orders:", err);
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [reserveGroupId]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const handleReleaseReserve = useCallback(
    async (orderId: number) => {
      setConfirmReleaseOrderId(orderId);
    },
    [],
  );

  const confirmRelease = useCallback(
    async (orderId: number) => {
      try {
        setReleasingOrderId(orderId);
        await OrderService.releaseReserve(orderId);
        toast.success("بسته رزروی شما برای ارسال آماده شد");
        setConfirmReleaseOrderId(null);
        await loadOrders();
      } catch (err) {
        console.error("Failed to release reserve:", err);
        toast.error("خطا در به‌روزرسانی. لطفاً دوباره تلاش کنید.");
      } finally {
        setReleasingOrderId(null);
      }
    },
    [loadOrders],
  );

  const mapOrderToProps = useCallback(
    (order: Order) =>
      mapOrderToDisplayProps(order, {
        imageBaseUrl: IMAGE_BASE_URL,
        placeholderImage: PLACEHOLDER_IMAGE,
        formatDate: formatOrderDate,
        formatTime: formatOrderTime,
        faNum,
        ordersLength: orders.length,
        handleReleaseReserve,
        persistOrderSnapshot,
        releasingOrderId,
        setSelectedOrder,
      }),
    [orders.length, handleReleaseReserve, releasingOrderId],
  );

  const rows = useMemo(() => orders.map(mapOrderToProps), [orders, mapOrderToProps]);

  if (!reserveGroupId) {
    return (
      <UserContainer className="flex flex-col gap-6 py-6 lg:py-10" dir="rtl">
        <p className="text-slate-600">شناسه گروه رزرو نامعتبر است.</p>
        <Link href="/orders" prefetch={false} className="text-infinity-primary hover:underline">
          بازگشت به سفارش‌ها
        </Link>
      </UserContainer>
    );
  }

  return (
    <UserContainer className="flex flex-col gap-6 py-6 lg:py-10" dir="rtl">
      <StorefrontAccountShell contentClassName="flex flex-col gap-6">
          <nav className="flex items-center gap-2 text-sm text-slate-500">
            <Link href="/orders" prefetch={false} className="hover:text-infinity-primary">
              سفارش‌ها
            </Link>
            <ChevronRight className="h-4 w-4 rotate-180" />
            <span className="text-slate-700">سفارش رزروی ({faNum(orders.length)} سفارش)</span>
          </nav>

          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold text-foreground-primary lg:text-3xl">
              سفارش رزروی
            </h1>
            <p className="text-sm text-slate-500 lg:text-base">
              {orders.length > 0
                ? `${faNum(orders.length)} سفارش در این گروه. برای مشاهده جزئیات هر سفارش روی آن کلیک کنید.`
                : "سفارشی در این گروه یافت نشد."}
            </p>
          </div>

          {/*
            Group-level header. Everything here comes from the group row rather
            than from any one member order, so the deadline, the reason the window
            closed and the shipping actually charged are stated once for the whole
            shipment.
          */}
          {group && (
            <section
              data-testid="reserve-group-header"
              className={`flex flex-col gap-4 rounded-2xl border p-4 lg:p-5 ${
                group.isActive ? "border-amber-200 bg-amber-50/40" : "border-slate-200 bg-white"
              }`}
            >
              <header className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                  <Package className="h-4 w-4 text-infinity-primary" />
                  وضعیت بسته رزروی
                </h2>
                <span
                  data-testid="reserve-group-state"
                  className={`rounded-pill px-2.5 py-1 text-xs ${
                    group.isActive ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {reserveStateLabel(group.state, group.closureReason)}
                </span>
              </header>

              {group.isActive && (
                <div className="flex flex-col gap-1 rounded-control bg-white/70 p-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-amber-900">
                    <Clock className="h-4 w-4" />
                    مهلت افزودن سفارش: {formatReserveRemaining(group.expiresAt)}
                  </p>
                  <p className="text-xs text-amber-800">
                    پایان مهلت رزرو: {formatReserveDeadline(group.expiresAt)}
                  </p>
                  <p className="text-xs text-neutral-500">
                    این زمان مهلت افزودن سفارش است، نه زمان تحویل توسط پیک.
                  </p>
                </div>
              )}

              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-slate-500">تعداد سفارش‌های بسته</dt>
                  <dd className="text-neutral-800">{faNum(group.orderCount)} سفارش</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">هزینه ارسال</dt>
                  <dd className="text-neutral-800">
                    {group.shippingCostPaid > 0
                      ? `${faNum(group.shippingCostPaid)} تومان — یک‌بار برای کل بسته`
                      : "پرداخت‌شده برای کل بسته"}
                  </dd>
                </div>
                <div className="flex items-start gap-1.5">
                  <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <div>
                    <dt className="text-xs text-slate-500">روش ارسال</dt>
                    <dd className="text-neutral-800">
                      {group.shippingMethodTitle || "ثبت‌شده در سفارش رزروی"}
                    </dd>
                  </div>
                </div>
                {group.destination && (
                  <div className="flex items-start gap-1.5">
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <div>
                      <dt className="text-xs text-slate-500">مقصد</dt>
                      <dd className="text-neutral-800">{group.destination}</dd>
                    </div>
                  </div>
                )}
                {group.lastOrderAttachedAt && (
                  <div>
                    <dt className="text-xs text-slate-500">آخرین سفارش اضافه‌شده</dt>
                    <dd className="text-neutral-800">
                      {formatFaDateTime(group.lastOrderAttachedAt)}
                    </dd>
                  </div>
                )}
                {group.lastActivityAt && (
                  <div>
                    <dt className="text-xs text-slate-500">آخرین فعالیت</dt>
                    <dd className="text-neutral-800">{formatFaDateTime(group.lastActivityAt)}</dd>
                  </div>
                )}
                {group.shippingBarcode && (
                  <div>
                    <dt className="text-xs text-slate-500">کد رهگیری مرسوله</dt>
                    <dd className="font-medium text-neutral-800">{group.shippingBarcode}</dd>
                  </div>
                )}
              </dl>

              {group.isActive && group.rootOrderId && (
                <button
                  type="button"
                  onClick={() => setConfirmReleaseOrderId(group.rootOrderId!)}
                  className="self-start rounded-lg border border-infinity-primary-lighter/60 bg-white px-4 py-2 text-sm font-medium text-infinity-primary transition hover:bg-infinity-primary-lighter/20"
                >
                  ارسال الان
                </button>
              )}
            </section>
          )}

          {loading ? (
            <>
              <div className="lg:hidden">
                {Array.from({ length: 3 }).map((_, i) => (
                  <OrderCardSkeleton key={i} />
                ))}
              </div>
              <div className="hidden overflow-x-auto lg:flex">
                <table className="w-full">
                  <tbody className="divide-y divide-gray-100">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <OrderRowSkeleton key={i} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : rows.length === 0 ? (
            <div className="rounded-lg bg-gray-50 p-8 text-center">
              <p className="text-gray-600">سفارشی در این گروه یافت نشد.</p>
              <Link
                href="/orders"
                prefetch={false}
                className="mt-4 inline-block text-infinity-primary hover:underline"
              >
                بازگشت به لیست سفارش‌ها
              </Link>
            </div>
          ) : (
            <>
              <div className="lg:hidden">
                {rows.map((row) => {
                  const { rawOrder, isGroupRow, sortDate, ...rest } = row;
                  return <OrderCard key={row.id} {...rest} />;
                })}
              </div>
              <div className="hidden overflow-x-auto lg:flex">
                <table className="w-full">
                  <tbody className="divide-y divide-gray-100">
                    {rows.map((row) => {
                      const { rawOrder, isGroupRow, sortDate, ...rest } = row;
                      return <OrderRow key={row.id} {...rest} />;
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </StorefrontAccountShell>

      <OrderDetailsDrawer
        isOpen={Boolean(selectedOrder)}
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />

      <ConfirmDialog
        isOpen={confirmReleaseOrderId !== null}
        title="ارسال زودهنگام بسته رزروی"
        description="با این کار مهلت رزرو بسته می‌شود و پس از آن نمی‌توانید سفارش دیگری به این بسته اضافه کنید. سفارش‌های فعلی برای ارسال آماده می‌شوند. این عمل قابل بازگشت نیست."
        confirmText={releasingOrderId !== null ? "در حال پردازش..." : "بله، همین حالا ارسال شود"}
        cancelText="انصراف"
        confirmDisabled={releasingOrderId !== null}
        onConfirm={() => {
          if (confirmReleaseOrderId !== null) void confirmRelease(confirmReleaseOrderId);
        }}
        onCancel={() => setConfirmReleaseOrderId(null)}
      />
    </UserContainer>
  );
}
