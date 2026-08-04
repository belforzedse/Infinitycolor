"use client";

import { useEffect, useState } from "react";
import {
  getOrderAdminActivities,
  getProductAdminActivities,
  type AdminActivity,
  type AdminActivityChange,
} from "@/services/admin-activity";
import type { OrderTimelineEvent } from "@/components/User/Orders/Detail/OrderTimeline";
import {
  summarizeActivity,
  translateActivityRole,
  translateFieldLabel,
  formatChangeValue,
  getSeverityMeta,
  formatActivityRelative,
  formatActivityIp,
} from "@/utils/adminActivityLabels";

const formatChanges = (changes?: Record<string, AdminActivityChange> | null) => {
  if (!changes) return [] as { key: string; label: string; from: string; to: string }[];
  return Object.entries(changes).map(([key, change]) => ({
    key,
    label: translateFieldLabel(key),
    from: formatChangeValue(key, change?.from),
    to: formatChangeValue(key, change?.to),
  }));
};

interface SuperAdminActivityLogsProps {
  resourceType: "order" | "product";
  resourceId?: string | number;
  title: string;
  pageSize?: number;
  hideHeader?: boolean;
  onEventsChange?: (events: OrderTimelineEvent[]) => void;
}

export default function SuperAdminActivityLogs({
  resourceType,
  resourceId,
  title,
  pageSize = 50,
  hideHeader,
  onEventsChange,
}: SuperAdminActivityLogsProps) {
  const [activities, setActivities] = useState<AdminActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const fetchActivities = async () => {
      if (!resourceId) {
        setActivities([]);
        setLoading(false);
        setError(false);
        onEventsChange?.([]);
        return;
      }

      try {
        setLoading(true);
        setError(false);
        const response =
          resourceType === "order"
            ? await getOrderAdminActivities(resourceId, { pageSize })
            : await getProductAdminActivities(resourceId, { pageSize });
        if (cancelled) return;
        const list = response.data || [];
        setActivities(list);
        onEventsChange?.(
          list.map((activity) => ({
            id: activity.id,
            message: activity.Title || activity.Message || activity.Action,
            createdAt: activity.createdAt,
            severity: activity.Severity,
          })),
        );
      } catch (err) {
        if (cancelled) return;
        console.error("Error fetching super admin activities:", err);
        setActivities([]);
        setError(true);
        onEventsChange?.([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchActivities();
    return () => {
      cancelled = true;
    };
  }, [resourceId, resourceType, onEventsChange, pageSize]);

  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
      {!hideHeader && (
        <h2 className="text-foreground-primary mb-4 text-base font-semibold">{title}</h2>
      )}
      {loading ? (
        <div className="text-sm text-slate-500">در حال بارگذاری...</div>
      ) : error ? (
        <div className="text-sm text-red-500">خطا در دریافت رویدادها</div>
      ) : activities.length === 0 ? (
        <div className="text-sm text-slate-500">رویدادی ثبت نشده است</div>
      ) : (
        <ol className="relative space-y-4 border-r border-slate-200 pr-4">
          {activities.map((activity) => {
            const changes = formatChanges(activity.Changes);
            const actorName = activity.PerformedByName || activity.performed_by?.username;
            const roleLabel = translateActivityRole(activity.PerformedByRole);
            return (
              <li key={`${activity.id}-${activity.createdAt}`} className="relative">
                <span
                  className={`absolute -right-[31px] mt-1 h-4 w-4 rounded-full border-2 border-white shadow ring-2 ring-slate-100 ${
                    getSeverityMeta(activity.Severity).dotClass
                  }`}
                />
                <div className="flex flex-col gap-1 text-right">
                  <span className="text-foreground-primary text-sm font-medium">
                    {summarizeActivity(activity)}
                  </span>

                  {(actorName || roleLabel) && (
                    <span className="text-xs text-slate-600">
                      توسط {actorName || "ادمین"}
                      {roleLabel ? ` (${roleLabel})` : ""}
                    </span>
                  )}

                  {changes.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-1">
                      {changes.map((change) => (
                        <li
                          key={change.key}
                          className="min-w-0 break-words rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600 [overflow-wrap:anywhere]"
                        >
                          <span className="font-medium text-slate-700">{change.label}:</span>{" "}
                          <span className="text-slate-400">از</span>{" "}
                          <span className="text-slate-500">{change.from}</span>{" "}
                          <span className="text-slate-400">به</span>{" "}
                          <span className="text-slate-700">{change.to}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                    <span>{formatActivityRelative(activity.createdAt)}</span>
                    {activity.IP && (
                      <span className="font-mono text-slate-400" dir="ltr">
                        {formatActivityIp(activity.IP)}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
