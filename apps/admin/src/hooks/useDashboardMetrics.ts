"use client";

import {
  getAdminDashboardSummary,
  type DashboardSummaryOrder,
} from "@/services/super-admin/dashboard/summary";
import { useEffect, useState } from "react";

export type DashboardMetric = {
  label: string;
  value: number;
  helper: string;
};

type DashboardState = {
  loading: boolean;
  metrics?: DashboardMetric[];
  latestOrders?: DashboardSummaryOrder[];
  latestOrdersAmount?: number;
  error?: string;
};

type UseDashboardMetricsOptions = {
  enabled?: boolean;
  includeUserMetric?: boolean;
};

export function useDashboardMetrics(options: UseDashboardMetricsOptions = {}) {
  const { enabled = true, includeUserMetric = true } = options;
  const [state, setState] = useState<DashboardState>({ loading: enabled });

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: undefined }));

    getAdminDashboardSummary(controller.signal)
      .then((summary) => {
        if (controller.signal.aborted) return;
        const metrics: DashboardMetric[] = [
          ...(summary.metrics.ordersTotal !== null ? [{
            label: "کل سفارش‌ها",
            value: summary.metrics.ordersTotal,
            helper: "تعداد سفارش‌های ثبت‌شده",
          }] : []),
          ...(summary.metrics.doneOrdersTotal !== null ? [{
            label: "سفارش‌های انجام‌شده",
            value: summary.metrics.doneOrdersTotal,
            helper: "سفارش‌هایی که وضعیت آن‌ها Done است",
          }] : []),
          ...(summary.metrics.activeProductsTotal !== null ? [{
            label: "محصولات فعال",
            value: summary.metrics.activeProductsTotal,
            helper: "محصولات فعال و حذف‌نشده",
          }] : []),
        ];

        if (
          includeUserMetric &&
          summary.metrics.customerAccountsTotal !== null
        ) {
          metrics.push({
            label: "حساب‌های مشتریان",
            value: summary.metrics.customerAccountsTotal,
            helper: "رکوردهای حساب مشتری فعال؛ نه کاربران آنلاین",
          });
        }

        setState({
          loading: false,
          metrics,
          latestOrders: summary.latestOrders,
          latestOrdersAmount: summary.latestOrdersAmount,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error && typeof error === "object" && "message" in error
            ? String(error.message)
            : "خطا در بارگذاری آمار Dashboard";
        setState({ loading: false, error: message });
      });

    return () => controller.abort();
  }, [enabled, includeUserMetric]);

  return enabled ? state : { loading: false };
}
