import { sanitize } from "@strapi/utils";
import {
  adminPagination,
  DEFAULT_ADMIN_PAGE_SIZE,
  MAX_ADMIN_PAGE,
  MAX_ADMIN_PAGE_SIZE,
  MAX_ADMIN_SEARCH_LENGTH,
  parseAdminFilters,
  positiveAdminInteger,
  rejectAdminListRequest,
  type AdminFilterDefinition,
} from "../../../utils/admin-list-query";
import {
  projectOrderReserve,
  UID as RESERVE_GROUP_UID,
} from "../../reserve-group/lib/reserve-group";

const FILTER_FIELDS: Record<string, AdminFilterDefinition> = {
  "[id]": { path: ["id"], type: "number" },
  "[contract][Amount]": { path: ["contract", "Amount"], type: "number" },
  "[contract][external_id]": {
    path: ["contract", "external_id"],
    type: "text",
  },
  "[Description]": { path: ["Description"], type: "text" },
  "[user][user_info][FirstName]": {
    path: ["user", "user_info", "FirstName"],
    type: "text",
  },
  "[user][user_info][LastName]": {
    path: ["user", "user_info", "LastName"],
    type: "text",
  },
  "[user][phone]": { path: ["user", "phone"], type: "text" },
  "[createdAt]": { path: ["createdAt"], type: "date" },
};

const TAB_FILTERS: Record<string, Record<string, unknown> | null> = {
  all: null,
  paying: { Status: { $eq: "Paying" } },
  inprogress: { Status: { $in: ["Started", "Shipment"] } },
  completed: { Status: { $eq: "Done" } },
  cancelled: { Status: { $in: ["Returned", "Cancelled"] } },
  manual: { Type: { $eq: "Manual" } },
};

const SORTS: Record<string, Array<Record<string, "asc" | "desc">>> = {
  "last-edited": [{ updatedAt: "desc" }, { id: "desc" }],
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
};

function projectOrder(order: any) {
  const user = order.user;
  const userInfo = user?.user_info;
  const contract = order.contract;
  return {
    id: order.id,
    attributes: {
      Description: order.Description ?? null,
      Note: order.Note ?? null,
      Status: order.Status ?? null,
      Date: order.Date ?? null,
      ShippingMethodCode: order.ShippingMethodCode ?? null,
      ShippingBarcode: order.ShippingBarcode ?? null,
      ShippingWeight: order.ShippingWeight ?? null,
      ShippingBoxSizeId: order.ShippingBoxSizeId ?? null,
      AnipoBarcodeState: order.AnipoBarcodeState ?? null,
      AnipoSubmittedAt: order.AnipoSubmittedAt ?? null,
      AnipoLastCheckedAt: order.AnipoLastCheckedAt ?? null,
      AnipoPollingDeadlineAt: order.AnipoPollingDeadlineAt ?? null,
      AnipoIssuedAt: order.AnipoIssuedAt ?? null,
      AnipoReadyToIssue: order.AnipoReadyToIssue ?? null,
      AnipoProviderStatus: order.AnipoProviderStatus ?? null,
      AnipoLastMessage: order.AnipoLastMessage ?? null,
      AnipoLastError: order.AnipoLastError ?? null,
      createdAt: order.createdAt ?? null,
      updatedAt: order.updatedAt ?? null,
      // Projected from the reserve group, not from the frozen order columns, so
      // the row reflects the window's real state rather than its state at
      // checkout. Lets the list show a hold badge and guard fulfillment actions.
      ...projectOrderReserve(order),
      user: {
        data: user
          ? {
              id: user.id,
              attributes: {
                Phone: user.phone ?? null,
                user_info: {
                  data: userInfo
                    ? {
                        id: userInfo.id,
                        attributes: {
                          FirstName: userInfo.FirstName ?? null,
                          LastName: userInfo.LastName ?? null,
                        },
                      }
                    : null,
                },
              },
            }
          : null,
      },
      contract: {
        data: contract
          ? {
              id: contract.id,
              attributes: {
                Type: contract.Type ?? null,
                Status: contract.Status ?? null,
                Amount: Number(contract.Amount) || 0,
                TaxPercent: Number(contract.TaxPercent) || 0,
                Date: contract.Date ?? null,
              },
            }
          : null,
      },
    },
  };
}

/** Digits only, after normalising Persian/Arabic numerals to ASCII. */
const ASCII_DIGITS = /^[0-9]+$/;

function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * Free-text order search.
 *
 * Previously this matched only the SnappPay transaction id, which meant an
 * operator could not look up an order by its own number — the single most
 * common lookup — without opening the advanced-filter dialog.
 *
 * The input is discriminated to keep the cheap case cheap: a numeric query is
 * almost always an order number, so it resolves against the primary key (plus
 * the transaction id, which is also numeric-ish) and never touches the
 * unindexed name/phone columns. Only genuinely textual queries fan out to the
 * relation `$containsi` predicates.
 */
function buildOrderSearchCondition(search: string): Record<string, unknown> {
  const normalized = normalizeDigits(search).replace(/^#/, "").trim();

  if (ASCII_DIGITS.test(normalized)) {
    const asId = Number(normalized);
    const numericConditions: Record<string, unknown>[] = [
      { contract: { external_id: { $containsi: normalized } } },
      { ShippingBarcode: { $containsi: normalized } },
      { user: { phone: { $containsi: normalized } } },
    ];
    // Guard against precision loss on absurdly long digit strings.
    if (Number.isSafeInteger(asId)) {
      numericConditions.unshift({ id: { $eq: asId } });
    }
    return { $or: numericConditions };
  }

  return {
    $or: [
      { contract: { external_id: { $containsi: search } } },
      { user: { user_info: { FirstName: { $containsi: search } } } },
      { user: { user_info: { LastName: { $containsi: search } } } },
      { ShippingBarcode: { $containsi: search } },
    ],
  };
}


/**
 * Operational segments for the reserve board. "Ending soon" is derived from the
 * deadline rather than stored, so there is no extra state to keep in sync.
 */
const RESERVE_ENDING_SOON_HOURS = Number(
  process.env.RESERVE_ENDING_SOON_HOURS || 6,
);

const RESERVE_TAB_FILTERS: Record<
  string,
  (now: Date) => Record<string, unknown> | null
> = {
  all: () => null,
  active: (now) => ({
    State: { $eq: "Active" },
    expiresAt: { $gt: now.toISOString() },
  }),
  ending_soon: (now) => ({
    State: { $eq: "Active" },
    expiresAt: {
      $gt: now.toISOString(),
      $lte: new Date(
        now.getTime() + RESERVE_ENDING_SOON_HOURS * 60 * 60 * 1000,
      ).toISOString(),
    },
  }),
  ready: () => ({ State: { $eq: "ReadyToFulfill" } }),
  fulfilling: () => ({ State: { $eq: "Fulfilling" } }),
  completed: () => ({ State: { $in: ["Completed", "Cancelled"] } }),
};

const RESERVE_SORTS: Record<string, Array<Record<string, "asc" | "desc">>> = {
  // Default is operational urgency: the soonest deadline first.
  deadline: [{ expiresAt: "asc" }, { id: "asc" }],
  "last-activity": [{ lastActivityAt: "desc" }, { id: "desc" }],
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
};

function buildReserveGroupSearchCondition(search: string): Record<string, unknown> {
  const normalized = normalizeDigits(search);
  if (ASCII_DIGITS.test(normalized)) {
    const asId = Number(normalized);
    const conditions: Record<string, unknown>[] = [
      { owner: { phone: { $containsi: normalized } } },
    ];
    if (Number.isSafeInteger(asId)) {
      conditions.unshift({ rootOrder: { id: { $eq: asId } } });
    }
    return { $or: conditions };
  }
  return {
    $or: [
      { groupKey: { $containsi: search } },
      { ShippingBarcode: { $containsi: search } },
      { owner: { user_info: { FirstName: { $containsi: search } } } },
      { owner: { user_info: { LastName: { $containsi: search } } } },
    ],
  };
}

/**
 * Group row for the admin board.
 *
 * Deliberately exposes `lastActivityAt` / `lastOrderAttachedAt` instead of a raw
 * `updatedAt`: automatic expiry touches only the group row, so "last edited" on a
 * member order keeps meaning "a human changed this order".
 */
async function projectReserveGroup(strapi: any, group: any, now: Date) {
  const [orderCount, itemAgg] = await Promise.all([
    strapi.query("api::order.order").count({
      where: { reserve_shipment: { id: group.id } },
    }),
    strapi.query("api::order.order").findMany({
      where: { reserve_shipment: { id: group.id } },
      populate: { order_items: { select: ["id", "Count"] }, contract: { select: ["Amount"] } },
      select: ["id"],
    }),
  ]);

  let itemCount = 0;
  let groupValue = 0;
  for (const order of (itemAgg as any[]) || []) {
    for (const item of order.order_items || []) {
      itemCount += Number(item?.Count) || 0;
    }
    groupValue += Number(order.contract?.Amount || 0);
  }

  const expiresAt = group.expiresAt ?? null;
  const remainingMs = expiresAt
    ? Math.max(0, new Date(expiresAt).getTime() - now.getTime())
    : null;
  const ownerInfo = group.owner?.user_info;
  const city = group.delivery_address?.shipping_city;

  return {
    id: group.id,
    groupKey: group.groupKey,
    state: group.State ?? null,
    closureReason: group.ClosureReason ?? null,
    isHeld: ["PendingActivation", "Active"].includes(String(group.State || "")),
    customer: {
      id: group.owner?.id ?? null,
      phone: group.owner?.phone ?? null,
      firstName: ownerInfo?.FirstName ?? null,
      lastName: ownerInfo?.LastName ?? null,
    },
    rootOrderId: group.rootOrder?.id ?? null,
    orderCount,
    itemCount,
    groupValue,
    shippingCostPaid: Number(group.ShippingCostPaid || 0),
    shippingMethodTitle: group.ShippingMethodTitle ?? group.shipping?.Title ?? null,
    shippingMethodCode: group.ShippingMethodCode ?? group.shipping?.Code ?? null,
    shippingBarcode: group.ShippingBarcode ?? null,
    destination: city
      ? [city.shipping_province?.Name, city.Name].filter(Boolean).join("، ")
      : null,
    activatedAt: group.activatedAt ?? null,
    expiresAt,
    closedAt: group.closedAt ?? null,
    remainingMs,
    lastOrderAttachedAt: group.lastOrderAttachedAt ?? null,
    lastActivityAt: group.lastActivityAt ?? null,
  };
}

export default {
  async query(ctx) {
    const startedAt = Date.now();
    const body = ctx.request?.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return rejectAdminListRequest(ctx, "Request body must be an object");
    }

    const page = Math.min(positiveAdminInteger(body.page, 1), MAX_ADMIN_PAGE);
    const pageSize = Math.min(
      positiveAdminInteger(body.pageSize, DEFAULT_ADMIN_PAGE_SIZE),
      MAX_ADMIN_PAGE_SIZE,
    );
    const search = String(body.search ?? "").trim();
    if (search.length > MAX_ADMIN_SEARCH_LENGTH) {
      return rejectAdminListRequest(ctx, "search must contain at most 80 characters");
    }

    const tab = String(body.tab || "all");
    if (!(tab in TAB_FILTERS)) {
      return rejectAdminListRequest(ctx, "Unsupported orders-list tab");
    }
    const sort = String(body.sort || "last-edited");
    if (!SORTS[sort]) {
      return rejectAdminListRequest(ctx, "Unsupported orders-list sort");
    }
    const filters = parseAdminFilters(ctx, body.filters, FILTER_FIELDS, "orders-list");
    if (!filters) return;

    const conditions = [...filters];
    if (TAB_FILTERS[tab]) conditions.push(TAB_FILTERS[tab]!);
    if (search) {
      conditions.push(buildOrderSearchCondition(search));
    }
    const where = conditions.length > 0 ? { $and: conditions } : {};
    const orderQuery = strapi.query("api::order.order");

    const [rows, total] = await Promise.all([
      orderQuery.findMany({
        where,
        select: [
          "id",
          "Description",
          "Note",
          "Status",
          "Date",
          "ShippingMethodCode",
          "ShippingBarcode",
          "ShippingWeight",
          "ShippingBoxSizeId",
          "AnipoBarcodeState",
          "AnipoSubmittedAt",
          "AnipoLastCheckedAt",
          "AnipoPollingDeadlineAt",
          "AnipoIssuedAt",
          "AnipoReadyToIssue",
          "AnipoProviderStatus",
          "AnipoLastMessage",
          "AnipoLastError",
          "createdAt",
          "updatedAt",
        ],
        populate: {
          user: {
            select: ["id", "phone"],
            populate: {
              user_info: { select: ["id", "FirstName", "LastName"] },
            },
          },
          contract: {
            select: ["id", "Type", "Status", "Amount", "TaxPercent", "Date"],
          },
          reserve_shipment: true,
        },
        orderBy: SORTS[sort],
        offset: (page - 1) * pageSize,
        limit: pageSize,
      }),
      orderQuery.count({ where }),
    ]);

    const schema = strapi.contentType("api::order.order");
    // Do not pass request auth into sanitize. Roles with only `order.read` lack
    // direct find grants on contract / user_info, so auth-aware sanitize emptied
    // those relations and the list rendered orders without names or amounts.
    // The select/populate above plus projectOrder() already bound the payload.
    const sanitizedRows = await sanitize.contentAPI.output(rows, schema);
    const data = (sanitizedRows as any[]).map(projectOrder);

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data,
      meta: { pagination: adminPagination(page, pageSize, total) },
    };

    strapi.log.info("admin orders list completed", {
      durationMs: Date.now() - startedAt,
      page,
      pageSize,
      returned: data.length,
      total,
      tab,
      sort,
      hasSearch: Boolean(search),
      filterCount: filters.length,
    });
  },

  /**
   * Reserve groups as the unit of work.
   *
   * Combined-shipping operations happen per parcel, not per order, so this is a
   * group-level list rather than a filter over order rows: one row per physical
   * shipment, with the member orders summarised on it.
   */
  async queryReserveGroups(ctx) {
    const startedAt = Date.now();
    const body = ctx.request?.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return rejectAdminListRequest(ctx, "Request body must be an object");
    }

    const page = Math.min(positiveAdminInteger(body.page, 1), MAX_ADMIN_PAGE);
    const pageSize = Math.min(
      positiveAdminInteger(body.pageSize, DEFAULT_ADMIN_PAGE_SIZE),
      MAX_ADMIN_PAGE_SIZE,
    );
    const search = String(body.search ?? "").trim();
    if (search.length > MAX_ADMIN_SEARCH_LENGTH) {
      return rejectAdminListRequest(ctx, "search must contain at most 80 characters");
    }

    const tab = String(body.tab || "all");
    if (!(tab in RESERVE_TAB_FILTERS)) {
      return rejectAdminListRequest(ctx, "Unsupported reserve-groups tab");
    }
    const sort = String(body.sort || "deadline");
    if (!RESERVE_SORTS[sort]) {
      return rejectAdminListRequest(ctx, "Unsupported reserve-groups sort");
    }

    const now = new Date();
    const conditions: Record<string, unknown>[] = [];
    const tabFilter = RESERVE_TAB_FILTERS[tab]?.(now);
    if (tabFilter) conditions.push(tabFilter);
    if (search) conditions.push(buildReserveGroupSearchCondition(search));
    const where = conditions.length > 0 ? { $and: conditions } : {};

    const groupQuery = strapi.query(RESERVE_GROUP_UID);
    const [rows, total] = await Promise.all([
      groupQuery.findMany({
        where,
        populate: {
          owner: { select: ["id", "phone"], populate: { user_info: true } },
          rootOrder: { select: ["id", "Status", "Date"] },
          shipping: { select: ["id", "Title", "Code"] },
          delivery_address: {
            populate: { shipping_city: { populate: { shipping_province: true } } },
          },
        },
        orderBy: RESERVE_SORTS[sort],
        offset: (page - 1) * pageSize,
        limit: pageSize,
      }),
      groupQuery.count({ where }),
    ]);

    const data = await Promise.all(
      (rows as any[]).map((group) => projectReserveGroup(strapi, group, now)),
    );

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data,
      meta: { pagination: adminPagination(page, pageSize, total) },
    };

    strapi.log.info("admin reserve groups list completed", {
      durationMs: Date.now() - startedAt,
      page,
      pageSize,
      returned: data.length,
      total,
      tab,
      sort,
      hasSearch: Boolean(search),
    });
  },

  /** One reserve group with every member order, for the admin detail view. */
  async getReserveGroup(ctx) {
    const groupKey = String(ctx.params?.groupKey || "").trim();
    if (!groupKey) return rejectAdminListRequest(ctx, "groupKey is required");

    const group: any = await strapi.query(RESERVE_GROUP_UID).findOne({
      where: { groupKey },
      populate: {
        owner: { select: ["id", "phone"], populate: { user_info: true } },
        rootOrder: { select: ["id", "Status", "Date"] },
        shipping: { select: ["id", "Title", "Code"] },
        delivery_address: {
          populate: { shipping_city: { populate: { shipping_province: true } } },
        },
      },
    });
    if (!group) return ctx.notFound("Reserve group not found");

    const now = new Date();
    const orders = await strapi.query("api::order.order").findMany({
      where: { reserve_shipment: { id: group.id } },
      populate: {
        contract: { select: ["id", "Amount", "Status"] },
        order_items: { select: ["id", "Count"] },
      },
      orderBy: [{ Date: "asc" }, { id: "asc" }],
    });

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data: {
        ...(await projectReserveGroup(strapi, group, now)),
        orders: (orders as any[]).map((order) => ({
          id: order.id,
          status: order.Status ?? null,
          date: order.Date ?? null,
          amount: Number(order.contract?.Amount || 0),
          contractStatus: order.contract?.Status ?? null,
          itemCount: (order.order_items || []).reduce(
            (sum: number, item: any) => sum + (Number(item?.Count) || 0),
            0,
          ),
          shippingCost: Number(order.ShippingCost || 0),
          shippingBarcode: order.ShippingBarcode ?? null,
          isRoot: Number(group.rootOrder?.id) === Number(order.id),
        })),
      },
    };
  },
};
