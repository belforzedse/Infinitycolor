/**
 * One request shape for an order's log collection.
 *
 * The order sidebar and the technical gateway-log panel both read this
 * collection. They used to build their own URLs with opposite `sort` values
 * and no page size, so opening the technical panel issued a second full fetch
 * that could not share the first one's in-flight request or cache entry.
 * Consumers that want oldest-first reverse the result locally.
 */
export const ORDER_LOGS_PAGE_SIZE = 100;

export const ORDER_LOGS_QUERY = (orderId: string | number | string[]) =>
  `/order-logs?filters[order][id][$eq]=${orderId}` +
  `&sort[0]=createdAt:desc` +
  `&pagination[pageSize]=${ORDER_LOGS_PAGE_SIZE}`;
