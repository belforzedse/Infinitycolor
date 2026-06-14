"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getAdminActivityById, AdminActivityLog } from "@/services/super-admin/reports/adminActivity";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import {
  translateAction,
  getActionBadgeClass,
  translateResourceType,
  getSeverityMeta,
  translateActivityRole,
  translateFieldLabel,
  formatChangeValue,
  translateMetadataKey,
  formatMetadataValue,
  formatActivityDateTime,
  formatActivityIp,
} from "@/utils/adminActivityLabels";

export default function AdminActivityDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id ? Number(params.id) : null;
  const [activity, setActivity] = useState<AdminActivityLog | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      router.push("/super-admin/reports/admin-activity");
      return;
    }

    setLoading(true);
    getAdminActivityById(id)
      .then((data) => {
        setActivity(data);
      })
      .catch((error) => {
        console.error("Error fetching admin activity:", error);
        const friendlyError = getUserFacingErrorMessage(error, "خطا در بارگذاری فعالیت");
        alert(`خطا در بارگذاری فعالیت: ${friendlyError}`);
        router.push("/super-admin/reports/admin-activity");
      })
      .finally(() => setLoading(false));
  }, [id, router]);

  if (loading) {
    return (
      <ContentWrapper title="جزئیات فعالیت ادمین">
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3">
            <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-infinity-primary"></div>
            <span className="text-neutral-600">در حال بارگذاری...</span>
          </div>
        </div>
      </ContentWrapper>
    );
  }

  if (!activity) {
    return (
      <ContentWrapper title="جزئیات فعالیت ادمین">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-neutral-600">فعالیت یافت نشد</p>
          <Link
            href="/super-admin/reports/admin-activity"
            className="mt-4 inline-block text-infinity-primary hover:text-infinity-primary-dark hover:underline"
          >
            بازگشت به لیست فعالیت‌ها
          </Link>
        </div>
      </ContentWrapper>
    );
  }

  const adminName = activity.PerformedByName || activity.performed_by?.username || activity.performed_by?.email || activity.performed_by?.phone || "نامشخص";
  const adminRole = translateActivityRole(activity.PerformedByRole) || activity.PerformedByRole || "-";
  const severityInfo = getSeverityMeta(activity.Severity);
  const changeEntries = activity.Changes ? Object.entries(activity.Changes) : [];
  const metadataEntries = activity.Metadata ? Object.entries(activity.Metadata) : [];
  const hasTechnical = changeEntries.length > 0 || metadataEntries.length > 0;

  const getResourceLink = () => {
    if (!activity.ResourceId || !activity.ResourceType) return null;

    switch (activity.ResourceType) {
      case "Order":
        return `/super-admin/orders/edit/${activity.ResourceId}`;
      case "Product":
        return `/super-admin/products/${activity.ResourceId}`;
      case "User":
        return `/super-admin/users/edit/${activity.ResourceId}`;
      default:
        return null;
    }
  };

  const resourceLink = getResourceLink();

  return (
    <ContentWrapper title="جزئیات فعالیت ادمین">
      <div className="space-y-6">
        {/* Back Button */}
        <Link
          href="/super-admin/reports/admin-activity"
          className="inline-flex items-center gap-2 text-infinity-primary hover:text-infinity-primary-dark hover:underline"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          بازگشت به لیست فعالیت‌ها
        </Link>

        {/* Activity Details Card */}
        <div className="rounded-2xl bg-white p-6">
          <div className="space-y-6">
            {/* Header Section */}
            <div className="flex items-start justify-between border-b border-neutral-200 pb-4">
              <div>
                <h2 className="text-2xl font-bold text-neutral-900">{activity.Title || activity.Description || "فعالیت ادمین"}</h2>
                {activity.Message && (
                  <p className="mt-2 text-neutral-600">{activity.Message}</p>
                )}
              </div>
              <span className={`inline-block rounded-full px-4 py-2 text-sm font-medium ${severityInfo.badgeClass}`}>
                {severityInfo.label}
              </span>
            </div>

            {/* Basic Information */}
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-neutral-600">تاریخ و زمان</label>
                <p className="mt-1 text-neutral-900">{formatActivityDateTime(activity.createdAt)}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-600">نوع فعالیت</label>
                <p className="mt-1">
                  <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${getActionBadgeClass(activity.Action)}`}>
                    {translateAction(activity.Action)}
                  </span>
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-600">نوع منبع</label>
                <p className="mt-1">
                  {translateResourceType(activity.ResourceType)}
                  {resourceLink && (
                    <Link
                      href={resourceLink}
                      className="mr-2 text-infinity-primary hover:text-infinity-primary-dark hover:underline"
                    >
                      (مشاهده #{activity.ResourceId})
                    </Link>
                  )}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-600">شناسه منبع</label>
                <p className="mt-1 text-neutral-900">{activity.ResourceId || "-"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-600">ادمین</label>
                <p className="mt-1 text-neutral-900">{adminName}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-600">نقش</label>
                <p className="mt-1">
                  <span className="inline-block rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700">
                    {adminRole}
                  </span>
                </p>
              </div>
              {activity.IP && (
                <div>
                  <label className="text-sm font-medium text-neutral-600">آدرس IP</label>
                  <p className="mt-1 text-neutral-900 font-mono text-sm">{formatActivityIp(activity.IP)}</p>
                </div>
              )}
              {activity.UserAgent && (
                <div>
                  <label className="text-sm font-medium text-neutral-600">مرورگر</label>
                  <p className="mt-1 text-neutral-900 text-sm">{activity.UserAgent}</p>
                </div>
              )}
            </div>

            {/* Changes Section — readable before/after, no raw JSON */}
            {changeEntries.length > 0 && (
              <div className="border-t border-neutral-200 pt-6">
                <h3 className="mb-4 text-lg font-semibold text-neutral-900">جزئیات تغییرات</h3>
                <div className="space-y-3">
                  {changeEntries.map(([key, change]) => (
                    <div
                      key={key}
                      className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 md:flex-row md:items-center md:justify-between"
                    >
                      <span className="font-medium text-neutral-900">{translateFieldLabel(key)}</span>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="rounded bg-white px-2 py-1 text-neutral-500 line-through">
                          {formatChangeValue(key, change?.from)}
                        </span>
                        <span className="text-neutral-400">←</span>
                        <span className="rounded bg-white px-2 py-1 font-medium text-neutral-800">
                          {formatChangeValue(key, change?.to)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Metadata Section — readable key/value list */}
            {metadataEntries.length > 0 && (
              <div className="border-t border-neutral-200 pt-6">
                <h3 className="mb-4 text-lg font-semibold text-neutral-900">اطلاعات اضافی</h3>
                <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {metadataEntries.map(([key, value]) => (
                    <div key={key} className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                      <dt className="text-xs font-medium text-neutral-600">{translateMetadataKey(key)}</dt>
                      <dd className="mt-1 break-words text-sm text-neutral-900">{formatMetadataValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/* Technical details — raw JSON kept available behind an opt-in disclosure */}
            {hasTechnical && (
              <details className="border-t border-neutral-200 pt-6">
                <summary className="cursor-pointer select-none text-sm font-medium text-neutral-600 hover:text-neutral-900">
                  جزئیات فنی
                </summary>
                <div className="mt-3 space-y-3">
                  {changeEntries.length > 0 && (
                    <pre className="max-h-64 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-700">
                      {JSON.stringify(activity.Changes, null, 2)}
                    </pre>
                  )}
                  {metadataEntries.length > 0 && (
                    <pre className="max-h-64 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-700">
                      {JSON.stringify(activity.Metadata, null, 2)}
                    </pre>
                  )}
                </div>
              </details>
            )}

            {/* Description Section */}
            {activity.Description && (
              <div className="border-t border-neutral-200 pt-6">
                <h3 className="mb-2 text-lg font-semibold text-neutral-900">توضیحات</h3>
                <p className="text-neutral-600">{activity.Description}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </ContentWrapper>
  );
}



