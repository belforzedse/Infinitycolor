"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  getAdminActivity,
  AdminActivityLog,
  AdminActivityAdmin,
} from "@/services/super-admin/reports/adminActivity";
import { DatePicker } from "zaman";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { faNum } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import ChevronDownIcon from "@/components/SuperAdmin/Layout/Icons/ChevronDownIcon";
import {
  ACTION_LABELS_FA,
  RESOURCE_TYPE_LABELS_FA,
  translateAction,
  translateResourceType,
  getActionBadgeClass,
  translateActivityRole,
  summarizeActivity,
  formatActivityDateTime,
  formatActivityIp,
} from "@/utils/adminActivityLabels";
import clsx from "clsx";
import { exportExcel } from "@/utils/exportExcel";

// Helper to determine if a delete is soft or hard
function isSoftDelete(activity: AdminActivityLog): boolean {
  if (activity.Action !== "Delete") return false;
  // Check Metadata for removedAt or check if Description indicates soft delete
  if (activity.Metadata?.removedAt) return true;
  // Check if the resource still exists (soft delete) vs hard delete
  // For now, we'll check Metadata for any indication of soft delete
  return !!activity.Metadata?.isSoftDelete;
}

// Headline for a row: prefer the backend Persian Title/Message, then a derived summary.
function activityTitle(activity: AdminActivityLog): string {
  return summarizeActivity(activity);
}

interface CollapsedGroup {
  id: string;
  adminName: string;
  adminRole: string;
  startTime: Date;
  endTime: Date;
  activities: AdminActivityLog[];
  isExpanded: boolean;
}

export default function AdminActivityReportPage() {
  const [start, setStart] = useState<Date>(new Date(Date.now() - 30 * 86400000));
  const [end, setEnd] = useState<Date>(new Date());
  const [activities, setActivities] = useState<AdminActivityLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState<string>("");
  const [selectedActionType, setSelectedActionType] = useState<string>("");
  const [selectedLogType, setSelectedLogType] = useState<string>("All");
  const [adminUsers, setAdminUsers] = useState<AdminActivityAdmin[]>([]);
  const [showSystemActivities, setShowSystemActivities] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Excel export function
  const exportToExcel = useCallback(async (data: AdminActivityLog[], startDate: Date, endDate: Date) => {
    if (!data || data.length === 0) {
      alert("داده‌ای برای خروجی وجود ندارد");
      return;
    }

    try {
      // Prepare data for Excel export
      const exportData = data.map((row, index) => ({
        rank: index + 1,
        admin: row.PerformedByName || row.performed_by?.username || row.performed_by?.email || row.performed_by?.phone || "نامشخص",
        role: translateActivityRole(row.PerformedByRole) || row.PerformedByRole || "نامشخص",
        resource: translateResourceType(row.ResourceType),
        action: translateAction(row.Action),
        title: activityTitle(row),
        ip: row.IP || "",
        datetime: formatActivityDateTime(row.createdAt),
      }));

      const filenameDate = (d: Date) => d.toLocaleDateString("fa-IR").replace(/\//g, "-");

      await exportExcel({
        filename: `گزارش-فعالیت-ادمین-${filenameDate(startDate)}-تا-${filenameDate(endDate)}`,
        sheets: [
          {
            name: "گزارش فعالیت ادمین",
            columns: [
              { header: "رتبه", key: "rank", width: 8, numFmt: "#,##0" },
              { header: "نام ادمین", key: "admin", width: 20 },
              { header: "نقش ادمین", key: "role", width: 15 },
              { header: "نوع گزارش", key: "resource", width: 15 },
              { header: "نوع فعالیت", key: "action", width: 15 },
              { header: "عنوان", key: "title", width: 30 },
              { header: "آدرس IP", key: "ip", width: 18 },
              { header: "تاریخ و زمان", key: "datetime", width: 20 },
            ],
            rows: exportData,
          },
          {
            name: "اطلاعات گزارش",
            columns: [
              { header: "شرح", key: "label", width: 20 },
              { header: "مقدار", key: "value", width: 30 },
            ],
            rows: [
              { label: "تاریخ شروع", value: startDate.toLocaleDateString("fa-IR") },
              { label: "تاریخ پایان", value: endDate.toLocaleDateString("fa-IR") },
              { label: "تاریخ تهیه گزارش", value: new Date().toLocaleDateString("fa-IR") },
              { label: "تعداد فعالیت‌ها", value: String(data.length) },
            ],
          },
        ],
      });
    } catch (error: unknown) {
      console.error("Error exporting to Excel:", error);
      const friendlyError = getUserFacingErrorMessage(error, "خطا در ایجاد فایل Excel");
      alert(`خطا در ایجاد فایل Excel: ${friendlyError}`);
    }
  }, []);

  const isValid = (d: Date) => d instanceof Date && !isNaN(d.getTime());
  const toISO = useCallback(
    (d: Date, fallback: Date) => (isValid(d) ? d.toISOString() : fallback.toISOString()),
    [],
  );
  const startISO = useMemo(
    () => toISO(start, new Date(Date.now() - 30 * 86400000)),
    [start, toISO],
  );
  const endISO = useMemo(() => toISO(end, new Date()), [end, toISO]);

  const normalizeDateInput = (d: any, prev: Date): Date => {
    if (d instanceof Date) return d;
    if (d && d.value instanceof Date) return d.value;
    const nd = new Date(d);
    return isValid(nd) ? nd : prev;
  };

  // Fetch data
  useEffect(() => {
    setLoading(true);
    getAdminActivity({
      startDate: startISO,
      endDate: endISO,
      performedBy: selectedUser ? Number(selectedUser) : undefined,
      logType: selectedLogType !== "All" ? selectedLogType : undefined,
      actionType: selectedActionType || undefined,
      page: 1,
      pageSize: 100,
    })
      .then((response) => {
        setActivities(response.data || []);
        // Prefer the backend's distinct-admins list (covers all pages, keyed by id). Only refresh
        // it when not filtering by a specific admin, so the dropdown doesn't collapse to one.
        const admins = response.meta?.admins;
        if (admins && !selectedUser) {
          setAdminUsers(admins.filter((a) => a.id != null));
        }
      })
      .catch((error) => {
        console.error("Error fetching admin activity:", error);
        const friendlyError = getUserFacingErrorMessage(error, "خطا در بارگذاری گزارش");
        alert(`خطا در بارگذاری گزارش: ${friendlyError}`);
      })
      .finally(() => setLoading(false));
  }, [startISO, endISO, selectedUser, selectedActionType, selectedLogType]);

  const getAdminName = (activity: any) =>
    activity.PerformedByName ||
    activity.adminUsername ||
    activity.performed_by?.username ||
    activity.performed_by?.email ||
    activity.performed_by?.phone ||
    null;

  const filteredActivities = useMemo(
    () =>
      showSystemActivities
        ? activities
        : activities.filter((activity) => {
            const name = getAdminName(activity);
            return !!name && name !== "System";
          }),
    [activities, showSystemActivities]
  );

  // Collapse activities by user within 5-minute windows
  const collapsedActivities = useMemo(() => {
    const COLLAPSE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    const groups: CollapsedGroup[] = [];
    const processed = new Set<number>();

    filteredActivities.forEach((activity, index) => {
      if (processed.has(activity.id)) return;

      const adminName = getAdminName(activity) || "نامشخص";
      const adminRole = activity.PerformedByRole || "-";
      const activityTime = new Date(activity.createdAt || activity.timestamp || Date.now());

      // Generate stable group ID based on admin name and time window
      // This ensures the same logical group gets the same ID even when filters change
      const timeWindowIndex = Math.floor(activityTime.getTime() / COLLAPSE_WINDOW_MS);
      const stableGroupId = `group-${adminName}-${timeWindowIndex}`;

      // Find or create a group for this user within the time window
      let group = groups.find(
        (g) =>
          g.adminName === adminName &&
          Math.abs(activityTime.getTime() - g.endTime.getTime()) <= COLLAPSE_WINDOW_MS
      );

      if (!group) {
        group = {
          id: stableGroupId,
          adminName,
          adminRole,
          startTime: activityTime,
          endTime: activityTime,
          activities: [],
          isExpanded: expandedGroups.has(stableGroupId),
        };
        groups.push(group);
      }

      group.activities.push(activity);
      group.endTime = activityTime > group.endTime ? activityTime : group.endTime;
      processed.add(activity.id);
    });

    return groups;
  }, [filteredActivities, expandedGroups]);

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  // Soft deletes get the dedicated label/colour; everything else uses the shared maps.
  const getActionDisplay = (activity: AdminActivityLog): string => {
    if (activity.Action === "Delete" && isSoftDelete(activity)) return ACTION_LABELS_FA["Delete-Soft"];
    return translateAction(activity.Action);
  };

  const rowActionBadgeClass = (activity: AdminActivityLog): string => {
    if (activity.Action === "Delete" && isSoftDelete(activity)) return getActionBadgeClass("Delete-Soft");
    return getActionBadgeClass(activity.Action);
  };

  const uniqueAdmins = new Set(
    filteredActivities.map((a) => getAdminName(a) || "Unknown")
  ).size;
  const createActions = filteredActivities.filter(
    (a) => a.Action === "Create"
  ).length;
  const updateActions = filteredActivities.filter(
    (a) => a.Action === "Update"
  ).length;
  const deleteActions = filteredActivities.filter(
    (a) => a.Action === "Delete"
  ).length;
  const softDeleteActions = filteredActivities.filter(
    (a) => a.Action === "Delete" && isSoftDelete(a)
  ).length;
  const hardDeleteActions = deleteActions - softDeleteActions;

  const visibleCount = filteredActivities.length;

  return (
    <ContentWrapper title="گزارش ادمین ها">
      <div className="space-y-6">
        {/* Filters Section */}
        <div className="rounded-2xl bg-white p-5">
          <div className="flex flex-col gap-4">
            <h3 className="text-lg font-medium text-neutral-700">فیلترها</h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-neutral-600">تاریخ شروع</label>
                <DatePicker
                  inputClass="w-full px-3 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-infinity-primary focus:border-transparent transition-all"
                  defaultValue={start}
                  onChange={(d: any) => setStart(normalizeDateInput(d, start))}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-neutral-600">تاریخ پایان</label>
                <DatePicker
                  inputClass="w-full px-3 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-infinity-primary focus:border-transparent transition-all"
                  defaultValue={end}
                  onChange={(d: any) => setEnd(normalizeDateInput(d, end))}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-neutral-600">نوع فعالیت</label>
                <select
                  value={selectedActionType}
                  onChange={(e) => setSelectedActionType(e.target.value)}
                  className="w-full px-3 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-infinity-primary focus:border-transparent transition-all"
                >
                  <option value="">همه</option>
                  <option value="Create">{ACTION_LABELS_FA["Create"]}</option>
                  <option value="Update">{ACTION_LABELS_FA["Update"]}</option>
                  <option value="Delete">{ACTION_LABELS_FA["Delete"]}</option>
                  <option value="Publish">{ACTION_LABELS_FA["Publish"]}</option>
                  <option value="Unpublish">{ACTION_LABELS_FA["Unpublish"]}</option>
                  <option value="Adjust">{ACTION_LABELS_FA["Adjust"]}</option>
                  <option value="StatusChange">{ACTION_LABELS_FA["StatusChange"]}</option>
                  <option value="Refund">{ACTION_LABELS_FA["Refund"]}</option>
                  <option value="Import">{ACTION_LABELS_FA["Import"]}</option>
                  <option value="Other">{ACTION_LABELS_FA["Other"]}</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-neutral-600">نوع گزارش</label>
                <select
                  value={selectedLogType}
                  onChange={(e) => setSelectedLogType(e.target.value)}
                  className="w-full px-3 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-infinity-primary focus:border-transparent transition-all"
                >
                  <option value="All">همه</option>
                  <option value="Order">{RESOURCE_TYPE_LABELS_FA["Order"]}</option>
                  <option value="Product">{RESOURCE_TYPE_LABELS_FA["Product"]}</option>
                  <option value="User">{RESOURCE_TYPE_LABELS_FA["User"]}</option>
                  <option value="Contract">{RESOURCE_TYPE_LABELS_FA["Contract"]}</option>
                  <option value="Discount">{RESOURCE_TYPE_LABELS_FA["Discount"]}</option>
                  <option value="Stock">{RESOURCE_TYPE_LABELS_FA["Stock"]}</option>
                  <option value="Admin">{RESOURCE_TYPE_LABELS_FA["Admin"]}</option>
                  <option value="Other">{RESOURCE_TYPE_LABELS_FA["Other"]}</option>
                </select>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-neutral-600">نمایش</label>
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex flex-col">
                  {adminUsers.length > 0 && (
                    <select
                      value={selectedUser}
                      onChange={(e) => setSelectedUser(e.target.value)}
                      className="w-full px-3 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-infinity-primary focus:border-transparent transition-all"
                    >
                      <option value="">همه ادمین‌ها</option>
                      {adminUsers.map((user) => (
                        <option key={user.id} value={String(user.id)}>
                          {user.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <label className="inline-flex items-center gap-2 text-sm text-neutral-600">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-neutral-300 text-infinity-primary focus:ring-infinity-primary"
                    checked={showSystemActivities}
                    onChange={(e) => setShowSystemActivities(e.target.checked)}
                  />
                  نمایش فعالیت‌های سیستمی
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Results Section */}
        <div className="rounded-2xl bg-white p-5">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center gap-3">
                <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-infinity-primary"></div>
                <span className="text-neutral-600">در حال بارگذاری...</span>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50 p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg mb-2 font-medium text-neutral-700">کل فعالیت‌ها</h3>
                      <p className="text-2xl font-bold text-blue-600">{faNum(visibleCount)}</p>
                    </div>
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100">
                      <svg
                        className="h-6 w-6 text-blue-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-green-100 bg-gradient-to-r from-green-50 to-emerald-50 p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg mb-2 font-medium text-neutral-700">ادمین‌های فعال</h3>
                      <p className="text-2xl font-bold text-green-600">{faNum(uniqueAdmins)}</p>
                    </div>
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                      <svg
                        className="h-6 w-6 text-green-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 4.354a4 4 0 110 5.292M15 19H9a6 6 0 016-6v0a6 6 0 016 6v0a2 2 0 01-2 2H7a2 2 0 01-2-2v0a6 6 0 016-6z"
                        />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-purple-100 bg-gradient-to-r from-purple-50 to-violet-50 p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg mb-2 font-medium text-neutral-700">ایجادها</h3>
                      <p className="text-2xl font-bold text-purple-600">{faNum(createActions)}</p>
                    </div>
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-100">
                      <svg
                        className="h-6 w-6 text-purple-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 4v16m8-8H4"
                        />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-amber-50 p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg mb-2 font-medium text-neutral-700">تغییرات</h3>
                      <p className="text-2xl font-bold text-orange-600">
                        {faNum(updateActions + deleteActions)}
                      </p>
                    </div>
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-100">
                      <svg
                        className="h-6 w-6 text-orange-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>

              {/* Export Button */}
              <div className="flex justify-end">
                <button
                  onClick={() => exportToExcel(filteredActivities, start, end)}
                  className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-white hover:bg-green-700 transition-colors"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  خروجی Excel
                </button>
              </div>

              {/* Activities Table */}
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50">
                      <th className="px-6 py-3 text-right text-sm font-medium text-neutral-700">تاریخ و زمان</th>
                      <th className="px-6 py-3 text-right text-sm font-medium text-neutral-700">ادمین</th>
                      <th className="px-6 py-3 text-right text-sm font-medium text-neutral-700">نقش</th>
                      <th className="px-6 py-3 text-right text-sm font-medium text-neutral-700">نوع گزارش</th>
                      <th className="px-6 py-3 text-right text-sm font-medium text-neutral-700">فعالیت</th>
                      <th className="px-6 py-3 text-right text-sm font-medium text-neutral-700">توضیحات</th>
                      <th className="px-6 py-3 text-right text-sm font-medium text-neutral-700">IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collapsedActivities.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-6 py-8 text-center text-neutral-500">
                          فعالیتی یافت نشد
                        </td>
                      </tr>
                    ) : (
                      collapsedActivities.map((group) => {
                        const shouldShowDetails = group.activities.length === 1 || expandedGroups.has(group.id);
                        const actionCounts = group.activities.reduce((acc, a) => {
                          const action = a.Action === "Delete" && isSoftDelete(a) ? "Delete-Soft" : a.Action;
                          acc[action] = (acc[action] || 0) + 1;
                          return acc;
                        }, {} as Record<string, number>);

                        const summaryText = group.activities.length > 1
                          ? `${faNum(group.activities.length)} تا عملیات${Object.entries(actionCounts)
                              .filter(([_, count]) => count > 0)
                              .map(([action, count]) => {
                                const actionName = action === "Delete-Soft" ? "حذف نرم" : ACTION_LABELS_FA[action] || action;
                                return `${faNum(count)} تا ${actionName}`;
                              })
                              .join("، ")}`
                          : "";

                        const isExpanded = expandedGroups.has(group.id);
                        const shouldCollapse = group.activities.length > 1;

                        return (
                          <React.Fragment key={group.id}>
                            {shouldCollapse ? (
                              <>
                                {/* Collapsed group header */}
                                <tr
                                  className="border-b border-neutral-100 bg-neutral-50 cursor-pointer hover:bg-neutral-100 transition-colors"
                                  onClick={() => toggleGroup(group.id)}
                                >
                                  <td className="px-6 py-3 text-sm text-neutral-600">
                                    {formatActivityDateTime(group.startTime)}
                                    <span className="mr-2 text-xs text-neutral-400">
                                      تا {new Date(group.endTime).toLocaleString("fa-IR", { hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                  </td>
                                  <td className="px-6 py-3 text-sm font-medium text-neutral-700">
                                    {group.adminName}
                                  </td>
                                  <td className="px-6 py-3 text-sm">
                                    <span className="inline-block rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700">
                                      {translateActivityRole(group.adminRole) || group.adminRole}
                                    </span>
                                  </td>
                                  <td className="px-6 py-3 text-sm text-neutral-600" colSpan={4}>
                                    <div className="flex items-center justify-between">
                                      <span className="text-neutral-700 font-medium">{summaryText}</span>
                                      <div className={clsx("transition-transform duration-200", isExpanded && "rotate-180")}>
                                        <ChevronDownIcon />
                                      </div>
                                    </div>
                                  </td>
                                </tr>

                                {/* Expanded activities */}
                                {isExpanded && (
                                  <tr key={`${group.id}-expanded`}>
                                    <td colSpan={7} className="p-0">
                                      <div className="overflow-hidden bg-neutral-50">
                                          <div className="px-6 py-2">
                                            <table className="w-full">
                                              <tbody>
                                                {group.activities.map((activity, index) => {
                                                  const adminName = getAdminName(activity) || "نامشخص";
                                                  const adminRole = activity.PerformedByRole || activity.adminRole || "-";
                                                  const title = activityTitle(activity);
                                                  const timestamp = activity.timestamp || activity.createdAt;

                                                  return (
                                                    <tr
                                                      key={activity.id}
                                                      className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-100"
                                                    >
                                                      <td className="px-4 py-3 text-sm text-neutral-600">
                                                        {formatActivityDateTime(timestamp)}
                                                      </td>
                                                      <td className="px-4 py-3 text-sm font-medium text-neutral-700">
                                                        {adminName}
                                                      </td>
                                                      <td className="px-4 py-3 text-sm">
                                                        <span className="inline-block rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700">
                                                          {translateActivityRole(adminRole) || adminRole}
                                                        </span>
                                                      </td>
                                                      <td className="px-4 py-3 text-sm text-neutral-600">
                                                        {translateResourceType(activity.ResourceType)}
                                                      </td>
                                                      <td className="px-4 py-3 text-sm">
                                                        <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${rowActionBadgeClass(activity)}`}>
                                                          {getActionDisplay(activity)}
                                                        </span>
                                                      </td>
                                                      <td className="px-4 py-3 text-sm text-neutral-600">
                                                        <Link
                                                          href={`/super-admin/reports/admin-activity/${activity.id}`}
                                                          className="text-infinity-primary hover:text-infinity-primary-dark hover:underline font-medium"
                                                        >
                                                          {title}
                                                        </Link>
                                                      </td>
                                                      <td className="px-4 py-3 text-xs text-neutral-500">
                                                        {formatActivityIp(activity.IP)}
                                                      </td>
                                                    </tr>
                                                  );
                                                })}
                                              </tbody>
                                            </table>
                                          </div>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </>
                            ) : (
                              // Single activity - show directly without collapse
                              group.activities.map((activity) => {
                                const adminName = getAdminName(activity) || "نامشخص";
                                const adminRole = activity.PerformedByRole || activity.adminRole || "-";
                                const title = activityTitle(activity);
                                const timestamp = activity.timestamp || activity.createdAt;

                                return (
                                  <tr key={activity.id} className="border-b border-neutral-100 hover:bg-neutral-50">
                                    <td className="px-6 py-3 text-sm text-neutral-600">
                                      {formatActivityDateTime(timestamp)}
                                    </td>
                                    <td className="px-6 py-3 text-sm font-medium text-neutral-700">
                                      {adminName}
                                    </td>
                                    <td className="px-6 py-3 text-sm">
                                      <span className="inline-block rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700">
                                        {translateActivityRole(adminRole) || adminRole}
                                      </span>
                                    </td>
                                    <td className="px-6 py-3 text-sm text-neutral-600">
                                      {translateResourceType(activity.ResourceType)}
                                    </td>
                                    <td className="px-6 py-3 text-sm">
                                      <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${rowActionBadgeClass(activity)}`}>
                                        {getActionDisplay(activity)}
                                      </span>
                                    </td>
                                    <td className="px-6 py-3 text-sm text-neutral-600">
                                      <Link
                                        href={`/super-admin/reports/admin-activity/${activity.id}`}
                                        className="text-infinity-primary hover:text-infinity-primary-dark hover:underline font-medium"
                                      >
                                        {title}
                                      </Link>
                                    </td>
                                    <td className="px-6 py-3 text-xs text-neutral-500">
                                      {formatActivityIp(activity.IP)}
                                    </td>
                                  </tr>
                                );
                              })
                            )}
                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </ContentWrapper>
  );
}
