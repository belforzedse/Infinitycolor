"use client";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { useMe } from "@/hooks/api/useMe";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import Link from "next/link";
import { faNum } from "@/utils/faNum";
import {
  DashboardMetric,
  useDashboardMetrics,
} from "@/hooks/useDashboardMetrics";
import { getOrderStatusMeta } from "@/utils/statusTranslations";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  canSeeDashboardUserMetric,
  getDashboardQuickActions,
} from "@/constants/superAdminDashboard";

const statusToneBadge: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  danger: "bg-red-100 text-red-700",
  info: "bg-blue-100 text-blue-700",
};

const TODAY_ORDER_CARDS = [
  { key: "all", label: "کل سفارش‌های امروز" },
  { key: "paying", label: "در انتظار پرداخت" },
  { key: "inprogress", label: "در حال انجام" },
  { key: "completed", label: "تکمیل‌شده" },
  { key: "shipped", label: "ارسال شده" },
  { key: "cancelled", label: "لغو یا مرجوع" },
] as const;

export default function SuperAdminPage() {
  const { data: me, isLoading, error } = useMe();
  const { adminRole, capabilities } = useCurrentUser();
  const showUserMetric = canSeeDashboardUserMetric(capabilities);
  const canReadOrders = capabilities.includes("order.read");
  const {
    metrics,
    latestOrders,
    latestOrdersAmount,
    todayOrderCounts,
    activeReserveGroups,
    loading: metricsLoading,
    error: metricsError,
  } = useDashboardMetrics({
    enabled: Boolean(adminRole),
    includeUserMetric: showUserMetric,
  });

  const name = `${me?.FirstName || ""} ${me?.LastName || ""}`;
  const userFacingError = error
    ? getUserFacingErrorMessage(error, "خطا در دریافت اطلاعات کاربری")
    : null;

  const filteredMetrics = metrics;
  const filteredQuickActions = getDashboardQuickActions(capabilities);

  const notifications = (latestOrders ?? []).map((order: any) => {
    // Extract nested Strapi attributes
    const attributes = order?.attributes || {};
    const userAttributes = order?.attributes?.user?.data?.attributes || {};
    const userInfoAttributes =
      userAttributes?.user_info?.data?.attributes || {};
    const contractAttributes =
      order?.attributes?.contract?.data?.attributes || {};

    const firstName = userInfoAttributes?.FirstName || "";
    const lastName = userInfoAttributes?.LastName || "";
    const fullName = `${firstName} ${lastName}`.trim();

    const key =
      order?.id ??
      attributes?.OrderNumber ??
      attributes?.createdAt ??
      attributes?.updatedAt;
    const timestamp = attributes?.updatedAt ?? attributes?.createdAt;
    const time = timestamp
      ? new Date(timestamp).toLocaleTimeString("fa-IR", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";
    const statusMeta = getOrderStatusMeta(attributes.Status);
    return {
      title: `سفارش #${order.id}`,
      details: `${fullName || "مشتری نامشخص"} - ${statusMeta.label}`,
      statusLabel: statusMeta.label,
      time,
      badge: statusToneBadge[statusMeta.tone] ?? statusToneBadge.info,
      amount: Number(contractAttributes?.Amount ?? 0),
      id: key,
    };
  });

  return (
    <ContentWrapper title={`سلام ${name.trim() || "همکار گرامی"}`}>
      {userFacingError && (
        <p className="text-sm text-red-500" dir="rtl">
          {userFacingError}
        </p>
      )}
      {isLoading && !error && (
        <p className="text-sm text-neutral-500">در حال بارگذاری...</p>
      )}
      {metricsError && (
        <p className="mt-3 text-sm text-red-500" dir="rtl">
          {metricsError}
        </p>
      )}

      <section className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {(metricsLoading || !filteredMetrics
          ? Array.from(
              { length: showUserMetric ? 4 : 3 },
              () => null as DashboardMetric | null,
            )
          : filteredMetrics
        ).map((metric, index) => (
          <article
            key={metric?.label ?? index}
            className={`flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white/80 px-4 py-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
              !metric ? "animate-pulse" : ""
            }`}
          >
            <span className="text-xs uppercase tracking-wide text-slate-500">
              {metric?.label ?? "\u00A0"}
            </span>
            <strong className="text-3xl font-semibold text-slate-900">
              {metric ? faNum(metric.value) : "\u00A0"}
            </strong>
            <p className="text-sm text-slate-500">
              {metric?.helper ?? "\u00A0"}
            </p>
          </article>
        ))}
      </section>

      {canReadOrders && (metricsLoading || todayOrderCounts) && (
        <section className="mt-6" aria-labelledby="today-orders-heading">
          <h2
            id="today-orders-heading"
            className="text-lg font-semibold text-slate-900"
          >
            سفارش‌های امروز
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {TODAY_ORDER_CARDS.map((card) => (
              <article
                key={card.key}
                className={`rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 shadow-sm ${
                  metricsLoading ? "animate-pulse" : ""
                }`}
              >
                <p className="text-sm text-slate-500">{card.label}</p>
                <strong className="mt-2 block text-2xl font-semibold text-slate-900">
                  {metricsLoading || !todayOrderCounts
                    ? "\u00A0"
                    : faNum(todayOrderCounts[card.key])}
                </strong>
              </article>
            ))}
          </div>
        </section>
      )}

      {canReadOrders &&
        (metricsLoading || typeof activeReserveGroups === "number") && (
          <section className="mt-4">
            {metricsLoading || activeReserveGroups === undefined ? (
              <div className="h-14 animate-pulse rounded-2xl border border-slate-200 bg-white/80" />
            ) : (
              <Link
                href="/orders/reserve"
                className="flex min-h-14 items-center justify-between rounded-2xl border border-infinity-primary-lighter/40 bg-white px-4 py-3 text-sm font-semibold text-infinity-primary transition hover:bg-infinity-primary-lighter/20"
              >
                <span>رزروهای فعال</span>
                <span className="rounded-full bg-infinity-primary/10 px-2.5 py-1 text-sm">
                  {faNum(activeReserveGroups ?? 0)}
                </span>
              </Link>
            )}
          </section>
        )}

      <section className="mt-6 flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-slate-900">اقدامات سریع</h2>
        <div className="flex flex-wrap gap-3">
          {filteredQuickActions.map((action) => (
            <Link
              key={action.label}
              href={action.href}
              className="flex items-center gap-2 rounded-2xl border border-infinity-primary-lighter/40 bg-white px-4 py-3 text-sm font-semibold text-infinity-primary transition hover:bg-infinity-primary-lighter/20"
            >
              <span
                className="h-2 w-2 rounded-full bg-infinity-primary"
                aria-hidden
              />
              {action.label}
            </Link>
          ))}
        </div>
      </section>

      {canReadOrders && <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            سفارش‌های اخیر
          </h2>
          {latestOrders?.length ? (
            <p className="text-sm text-slate-500">
              جمع مبلغ سه سفارش اخیر: {faNum(latestOrdersAmount ?? 0)} تومان ·{" "}
              {faNum(latestOrders.length)} سفارش
            </p>
          ) : metricsLoading ? (
            <span className="text-sm text-slate-400">
              در حال دریافت داده‌ها…
            </span>
          ) : (
            <span className="text-sm text-slate-400">هنوز سفارشی ثبت نشده</span>
          )}
        </div>
        <div className="mt-3 space-y-3">
          {notifications && notifications.length > 0 ? (
            notifications.map((notification) => (
              <article
                key={notification.id}
                className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <strong className="text-base text-slate-900">
                    {notification.title}
                  </strong>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${notification.badge}`}
                  >
                    {notification.statusLabel}
                  </span>
                </div>
                <p className="text-sm text-slate-600">{notification.details}</p>
                <div className="flex items-center justify-between text-sm text-slate-500">
                  <span>{notification.time}</span>
                  <span>{faNum(notification.amount)} تومان</span>
                </div>
              </article>
            ))
          ) : (
            <article className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 shadow-sm">
              <p className="text-sm text-slate-500">
                اطلاعات سفارش‌ها هنوز در دسترس نیست.
              </p>
            </article>
          )}
        </div>
      </section>}
    </ContentWrapper>
  );
}
