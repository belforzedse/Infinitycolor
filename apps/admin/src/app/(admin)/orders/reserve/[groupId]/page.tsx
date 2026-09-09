"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertTriangle, Clock, MapPin, Package, Truck } from "lucide-react";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import {
  AdminSection,
  AdminStack,
  CopyableId,
  DetailHeader,
  StatusBadge,
} from "@/components/admin";
import { priceFormatter } from "@/utils/price";
import {
  formatFaDateTime,
  formatFaRelativeDateTime,
} from "@/utils/formatFaRelativeDateTime";
import { getOrderStatusMeta } from "@/utils/statusTranslations";
import {
  getAdminReserveGroup,
  type AdminReserveGroup,
} from "@/services/super-admin/orders/reserveGroups";
import {
  formatRemaining,
  getReserveGroupCustomer,
  getReserveGroupStatusMeta,
} from "../table";

type MemberOrder = {
  id: number;
  status: string | null;
  date: string | null;
  amount: number;
  contractStatus: string | null;
  itemCount: number;
};

type GroupDetail = AdminReserveGroup & { orders?: MemberOrder[] };

/**
 * One combined shipment, with its member orders.
 *
 * Every member order stays independently reachable at `/orders/edit/{id}` --
 * they are separate financial records and are never merged. This page adds the
 * shipment-level facts that no single order can carry: the deadline, why the
 * window closed, the shipping charged once, and the parcel's tracking.
 */
export default function ReserveGroupDetailPage() {
  const params = useParams();
  const groupKey = typeof params?.groupId === "string" ? params.groupId : null;
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!groupKey) return;
    try {
      setLoading(true);
      setError(null);
      const response = await getAdminReserveGroup(groupKey);
      setGroup((response.data as GroupDetail) ?? null);
    } catch (err) {
      console.error("Failed to load reserve group:", err);
      setError("خطا در دریافت اطلاعات بسته رزروی");
      setGroup(null);
    } finally {
      setLoading(false);
    }
  }, [groupKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!groupKey) {
    return (
      <ContentWrapper title="سفارش رزروی">
        <p className="text-neutral-600">شناسه بسته رزروی نامعتبر است.</p>
      </ContentWrapper>
    );
  }

  if (loading) {
    return (
      <ContentWrapper title="سفارش رزروی">
        <div className="h-40 animate-pulse rounded-2xl bg-neutral-100" />
      </ContentWrapper>
    );
  }

  if (error || !group) {
    return (
      <ContentWrapper title="سفارش رزروی">
        <p className="text-neutral-600">{error || "بسته رزروی یافت نشد."}</p>
        <Link href="/orders/reserve" className="text-blue-600 hover:underline">
          بازگشت به فهرست بسته‌های رزروی
        </Link>
      </ContentWrapper>
    );
  }

  const statusMeta = getReserveGroupStatusMeta(group);
  const customer = getReserveGroupCustomer(group);
  const members = group.orders ?? [];

  return (
    <ContentWrapper title="سفارش رزروی">
      <AdminStack>
        <DetailHeader
          backHref="/orders/reserve"
          backLabel="بازگشت به بسته‌های رزروی"
          title={customer.label}
          identifier={<CopyableId value={group.groupKey} label="کپی شناسه بسته رزروی" />}
          badge={<StatusBadge label={statusMeta.label} tone={statusMeta.tone} />}
          summary={[
            {
              label: "سفارش‌های بسته",
              value: `${group.orderCount.toLocaleString("fa-IR")} سفارش · ${group.itemCount.toLocaleString("fa-IR")} قلم`,
            },
            { label: "ارزش بسته", value: priceFormatter(group.groupValue, " تومان") },
            {
              label: "ارسال پرداخت‌شده",
              value: priceFormatter(group.shippingCostPaid, " تومان"),
            },
            {
              label: "آخرین فعالیت",
              value: formatFaRelativeDateTime(group.lastActivityAt),
            },
          ]}
        />

        {group.isHeld && (
          <div
            data-testid="reserve-hold-banner"
            className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              این بسته در مهلت رزرو است و ارسال آن متوقف نگه داشته می‌شود. تا پایان مهلت یا
              آزادسازی زودهنگام توسط مشتری، صدور بارکد و تغییر وضعیت به «ارسال شده» برای
              سفارش‌های این بسته از سمت سرور رد می‌شود.
            </p>
          </div>
        )}

        <AdminSection title="اطلاعات بسته">
          <dl className="grid gap-4 text-sm md:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs text-neutral-500">وضعیت</dt>
              <dd className="text-neutral-800">
                {statusMeta.label}
                {group.closureReason ? ` — ${group.closureReason}` : ""}
              </dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-xs text-neutral-500">
                <Clock className="h-3 w-3" /> پایان مهلت رزرو
              </dt>
              <dd className="text-neutral-800">
                {group.expiresAt ? formatFaDateTime(group.expiresAt) : "—"}
                {group.state === "Active" && (
                  <span className="mr-1 text-xs text-amber-700">
                    ({formatRemaining(group.remainingMs)} باقی مانده)
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">فعال‌سازی</dt>
              <dd className="text-neutral-800">
                {group.activatedAt ? formatFaDateTime(group.activatedAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">بسته‌شدن مهلت</dt>
              <dd className="text-neutral-800">
                {group.closedAt ? formatFaDateTime(group.closedAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">آخرین سفارش اضافه‌شده</dt>
              <dd className="text-neutral-800">
                {group.lastOrderAttachedAt
                  ? formatFaRelativeDateTime(group.lastOrderAttachedAt)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">سفارش اصلی</dt>
              <dd>
                {group.rootOrderId ? (
                  <Link
                    href={`/orders/edit/${group.rootOrderId}`}
                    className="text-blue-600 hover:underline"
                  >
                    #{group.rootOrderId}
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-xs text-neutral-500">
                <Truck className="h-3 w-3" /> روش ارسال
              </dt>
              <dd className="text-neutral-800">{group.shippingMethodTitle || "—"}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-xs text-neutral-500">
                <MapPin className="h-3 w-3" /> مقصد
              </dt>
              <dd className="text-neutral-800">{group.destination || "—"}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-xs text-neutral-500">
                <Package className="h-3 w-3" /> کد رهگیری مرسوله
              </dt>
              <dd className="text-neutral-800">
                {group.shippingBarcode || "هنوز صادر نشده"}
              </dd>
            </div>
            {customer.phone && (
              <div>
                <dt className="text-xs text-neutral-500">تماس مشتری</dt>
                <dd className="text-neutral-800">{customer.phone}</dd>
              </div>
            )}
          </dl>
        </AdminSection>

        <AdminSection
          title="سفارش‌های این بسته"
          description="هر سفارش یک رکورد مالی مستقل است؛ فقط ارسال آن‌ها یکی می‌شود."
        >
          {members.length === 0 ? (
            <p className="text-sm text-neutral-500">سفارشی به این بسته متصل نیست.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" dir="rtl">
                <thead className="text-xs text-neutral-500">
                  <tr>
                    <th className="p-2 text-right">شماره سفارش</th>
                    <th className="p-2 text-right">تاریخ</th>
                    <th className="p-2 text-right">اقلام</th>
                    <th className="p-2 text-right">مبلغ</th>
                    <th className="p-2 text-right">وضعیت</th>
                    <th className="p-2 text-right"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {members.map((order) => {
                    const meta = getOrderStatusMeta(order.status ?? undefined);
                    const isRoot = order.id === group.rootOrderId;
                    return (
                      <tr key={order.id} data-testid="reserve-member-order">
                        <td className="p-2">
                          #{order.id}
                          {isRoot && (
                            <span className="mr-1 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600">
                              سفارش اصلی
                            </span>
                          )}
                        </td>
                        <td className="p-2">{order.date ? formatFaDateTime(order.date) : "—"}</td>
                        <td className="p-2">{order.itemCount.toLocaleString("fa-IR")}</td>
                        <td className="p-2">{priceFormatter(order.amount, " تومان")}</td>
                        <td className="p-2">
                          <StatusBadge label={meta.label} tone={meta.tone} />
                        </td>
                        <td className="p-2">
                          <Link
                            href={`/orders/edit/${order.id}`}
                            className="text-blue-600 hover:underline"
                          >
                            مشاهده سفارش
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </AdminSection>
      </AdminStack>
    </ContentWrapper>
  );
}
