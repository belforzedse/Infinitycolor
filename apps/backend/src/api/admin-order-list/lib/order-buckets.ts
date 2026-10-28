// Completing a Started order now advances through Done to Shipment. Keep the
// Done bucket for historical rows that predate the automatic transition.
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
  "anipo_attention",
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
  anipo_attention: { $or: [
    { $and: [
      { $or: [{ reserve_shipment: { id: { $null: true } } }, { reserve_shipment: { AnipoBarcodeState: { $null: true } } }] },
      { $or: [{ AnipoBarcodeState: "NeedsAttention" }, { AnipoRecipientSyncState: "NeedsAttention" }] },
    ] },
    { Status: { $in: ["Started", "Done", "Shipment"] }, reserve_shipment: { $or: [
      { AnipoBarcodeState: "NeedsAttention" }, { AnipoRecipientSyncState: "NeedsAttention" },
    ] } },
  ] },
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
