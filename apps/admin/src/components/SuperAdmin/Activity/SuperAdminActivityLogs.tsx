"use client";

import type { OrderTimelineEvent } from "@/components/User/Orders/Detail/OrderTimeline";
import AuditTimeline, {
  type ContextualTimelineEvent,
} from "@/components/SuperAdmin/Audit/AuditTimeline";

export default function SuperAdminActivityLogs({
  resourceType,
  resourceId,
  title,
  pageSize = 50,
  hideHeader,
  onEventsChange,
}: {
  resourceType: "order" | "product";
  resourceId?: string | number;
  title: string;
  pageSize?: number;
  hideHeader?: boolean;
  onEventsChange?: (events: OrderTimelineEvent[]) => void;
}) {
  return (
    <AuditTimeline
      targetType={resourceType}
      targetId={resourceId}
      title={title}
      pageSize={pageSize}
      hideHeader={hideHeader}
      onEventsChange={onEventsChange as ((events: ContextualTimelineEvent[]) => void) | undefined}
    />
  );
}
