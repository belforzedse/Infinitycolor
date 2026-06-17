"use client";

import SuperAdminActivityLogs from "@/components/SuperAdmin/Activity/SuperAdminActivityLogs";
import type { OrderTimelineEvent } from "@/components/User/Orders/Detail/OrderTimeline";

interface SuperAdminOrderLogsProps {
  orderId?: string | number;
  pageSize?: number;
  hideHeader?: boolean;
  onEventsChange?: (events: OrderTimelineEvent[]) => void;
}

export default function SuperAdminOrderLogs({
  orderId,
  pageSize = 50,
  hideHeader,
  onEventsChange,
}: SuperAdminOrderLogsProps) {
  return (
    <SuperAdminActivityLogs
      resourceType="order"
      resourceId={orderId}
      pageSize={pageSize}
      hideHeader={hideHeader}
      onEventsChange={onEventsChange}
      title="رویدادهای سفارش"
    />
  );
}
