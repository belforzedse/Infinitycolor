// Fulfilment runs Started -> Done («تکمیل شده») -> Shipment («ارسال»), so `Done`
// is a mid-flow bucket and `Shipment` is the terminal one. The «تکمیل شده» tab
// keeps filtering `Done`; `Shipment` gets its own «ارسال شده» tab rather than
// being folded into either neighbour.
export const ORDER_STATUS_BUCKETS = {
  paying: ["Paying"],
  inprogress: ["Started"],
  completed: ["Done"],
  shipped: ["Shipment"],
  cancelled: ["Returned", "Cancelled"],
} as const;

export const ORDER_TAB_KEYS = [
  "all",
  "paying",
  "inprogress",
  "completed",
  "shipped",
  "cancelled",
  "manual",
] as const;

export type OrderTabKey = (typeof ORDER_TAB_KEYS)[number];

export const ORDER_TAB_FILTERS: Record<OrderTabKey, Record<string, unknown> | null> = {
  all: null,
  paying: { Status: { $in: [...ORDER_STATUS_BUCKETS.paying] } },
  inprogress: { Status: { $in: [...ORDER_STATUS_BUCKETS.inprogress] } },
  completed: { Status: { $in: [...ORDER_STATUS_BUCKETS.completed] } },
  shipped: { Status: { $in: [...ORDER_STATUS_BUCKETS.shipped] } },
  cancelled: { Status: { $in: [...ORDER_STATUS_BUCKETS.cancelled] } },
  // Manual is an order type, not a lifecycle status. It intentionally overlaps
  // the status buckets, matching the existing orders tab.
  manual: { Type: { $eq: "Manual" } },
};

export function orderWhereForTab(
  baseConditions: readonly Record<string, unknown>[],
  tab: OrderTabKey,
): Record<string, unknown> {
  const conditions = [...baseConditions];
  const tabFilter = ORDER_TAB_FILTERS[tab];
  if (tabFilter) conditions.push(tabFilter);
  return conditions.length > 0 ? { $and: conditions } : {};
}

export function activeReserveGroupsWhere(now = new Date()): Record<string, unknown> {
  return {
    State: { $eq: "Active" },
    expiresAt: { $gt: now.toISOString() },
  };
}
