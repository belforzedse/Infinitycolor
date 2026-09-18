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
import {
  customerPhoneSearchAlternatives,
  personNameSearchAlternatives,
} from "../../../utils/personIdentitySearch";
import {
  activeReserveGroupsWhere,
  ORDER_TAB_KEYS,
  orderWhereForTab,
  type OrderTabKey,
} from "../lib/order-buckets";

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
  // Separates combined-shipping orders from ordinary ones so they can be picked
  // out and printed apart — reserve invoices were coming off the printer mixed
  // in with the rest of the «در حال انجام» batch.
  //
  // Filters the RELATION, never the frozen `is_reserve_order` column: that column
  // is stamped at checkout and never rewritten, so it lies about closed groups.
  // `projectOrderReserve` derives the row's reserve view the same way.
  //
  // Typed "select" because the shared AdminFilterType has no "boolean"; it is
  // driven by $null/$notNull, both of which SELECT_OPERATORS already allows and
  // normalizeValue short-circuits to `true`.
  "[reserve_shipment][id]": { path: ["reserve_shipment", "id"], type: "select" },
};

const SORTS: Record<string, Array<Record<string, "asc" | "desc">>> = {
  "last-edited": [{ updatedAt: "desc" }, { id: "desc" }],
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
};

const MAX_SHIPPING_METHOD_FILTERS = 100;

function parseShippingMethodCodes(ctx: any, value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SHIPPING_METHOD_FILTERS) {
    return rejectAdminListRequest(
      ctx,
      `shippingMethodCodes must be an array with at most ${MAX_SHIPPING_METHOD_FILTERS} items`,
    );
  }

  const codes: string[] = [];
  for (const rawCode of value) {
    if (typeof rawCode !== "string") {
      return rejectAdminListRequest(ctx, "Each shipping method code must be a string");
    }
    const code = rawCode.trim();
    if (!code || code.length > MAX_ADMIN_SEARCH_LENGTH) {
      return rejectAdminListRequest(
        ctx,
        "Shipping method codes must contain 1 to 80 characters",
      );
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

type OrderListCriteria = {
  conditions: Record<string, unknown>[];
  filters: Record<string, unknown>[];
  search: string;
  shippingMethodCodes: string[];
};

async function parseOrderListCriteria(
  ctx: any,
  body: Record<string, unknown>,
): Promise<OrderListCriteria | null> {
  const search = String(body.search ?? "").trim();
  if (search.length > MAX_ADMIN_SEARCH_LENGTH) {
    rejectAdminListRequest(ctx, "search must contain at most 80 characters");
    return null;
  }

  const filters = parseAdminFilters(ctx, body.filters, FILTER_FIELDS, "orders-list");
  if (!filters) return null;
  const shippingMethodCodes = parseShippingMethodCodes(ctx, body.shippingMethodCodes);
  if (!shippingMethodCodes) return null;

  const conditions: Record<string, unknown>[] = [...filters];
  if (shippingMethodCodes.length > 0) {
    conditions.push({
      $or: [
        { ShippingMethodCode: { $in: shippingMethodCodes } },
        {
          $and: [
            { ShippingMethodCode: { $null: true } },
            { shipping: { Code: { $in: shippingMethodCodes } } },
          ],
        },
      ],
    });
  }
  if (search) {
    conditions.push(
      buildOrderSearchCondition(search, await resolveOrdersByPaymentReference(search)),
    );
  }

  return { conditions, filters, search, shippingMethodCodes };
}

function recipientNameFromAddress(
  address: { FullName?: unknown } | null | undefined,
): string | null {
  const raw = address?.FullName;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name || null;
}

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
      // Fulfilment identity: the name on the parcel, not the account profile.
      recipientName: recipientNameFromAddress(order.delivery_address),
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
/** Upper bound of a Postgres `integer` column, which is what `orders.id` is. */
const PG_INT4_MAX = 2147483647;
/**
 * Equality binds against `varchar(n)` are Postgres 22001 when the value is
 * longer than n — even on SELECT. The admin search cap is 80 characters;
 * stored references (Woo numbers, gateway ids) fit in 64. Anything longer
 * is a name/barcode and must use `$containsi` (ILIKE), which coerces to text.
 */
const VARCHAR_EQ_MAX = 64;
/** `local_user_addresses.full_name` / schema `FullName` maxLength. */
const RECIPIENT_NAME_VARCHAR_MAX = 255;

function canEqualityMatchVarchar(value: string, maxLength = VARCHAR_EQ_MAX): boolean {
  return value.length > 0 && value.length <= maxLength && !/\s/.test(value);
}

function recipientNameContains(search: string): Record<string, unknown> {
  return {
    delivery_address: {
      FullName: { $containsi: search.slice(0, RECIPIENT_NAME_VARCHAR_MAX) },
    },
  };
}

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
function buildOrderSearchCondition(
  search: string,
  paymentReferenceOrderIds: number[],
): Record<string, unknown> {
  const normalized = normalizeDigits(search).replace(/^#/, "").trim();
  // Resolved against the transaction rows up front, so neither the list nor the
  // seven count queries have to join them.
  const referenceConditions: Record<string, unknown>[] =
    paymentReferenceOrderIds.length > 0
      ? [{ id: { $in: paymentReferenceOrderIds } }]
      : [];

  if (ASCII_DIGITS.test(normalized)) {
    const asId = Number(normalized);
    const numericConditions: Record<string, unknown>[] = [
      { contract: { external_id: { $containsi: normalized } } },
      // The order's own reference: the settled gateway id, and for migrated rows
      // the legacy WooCommerce order number an operator still quotes. `$eq`
      // only when the bind fits a varchar column — a longer paste is 22001.
      ...(canEqualityMatchVarchar(normalized)
        ? [{ external_id: { $eq: normalized } }]
        : []),
      { ShippingBarcode: { $containsi: normalized } },
      // Phones persist in four shapes, so `09…` never matched a stored `+989…`.
      // Gated on length: an order number must not drag the unindexed phone
      // column into the cheap numeric path.
      ...(isPhoneShaped(normalized)
        ? customerPhoneSearchAlternatives(normalized, "user")
        : []),
      ...referenceConditions,
    ];
    // `orders.id` is a Postgres int4, so the bound is 2147483647 — NOT
    // Number.isSafeInteger (2^53). A phone like 9123381098 is a perfectly safe JS
    // integer, so the old guard let it through and Postgres raised
    // "integer out of range", 500-ing the whole order list for any phone search.
    if (Number.isSafeInteger(asId) && asId >= 0 && asId <= PG_INT4_MAX) {
      numericConditions.unshift({ id: { $eq: asId } });
    }
    return { $or: numericConditions };
  }

  // A phone pasted with separators or a leading `+98` is not all-digits, so it
  // used to reach the text branch and match nothing at all.
  const phoneConditions = isPhoneShaped(normalized)
    ? customerPhoneSearchAlternatives(normalized, "user")
    : [];

  return {
    $or: [
      { contract: { external_id: { $containsi: search } } },
      // Names have spaces; gateway/Woo ids do not. Equality on a name would
      // never hit `external_id` and can 22001 if that varchar is narrower
      // than the typed name.
      ...(canEqualityMatchVarchar(search)
        ? [{ external_id: { $eq: search } }]
        : []),
      // Account names still split across FirstName/LastName. The list itself
      // shows delivery_address.FullName, which is one varchar, so ILIKE
      // (`$containsi`) is the operator that both matches and stays inside
      // the column width. Never `$eq` this field.
      ...personNameSearchAlternatives(search, "user"),
      recipientNameContains(search),
      { ShippingBarcode: { $containsi: search } },
      ...phoneConditions,
      ...referenceConditions,
    ],
  };
}

/**
 * Digits plus the separators operators paste. The bounds are what keeps the
 * unindexed phone column out of unrelated lookups: below seven digits it is an
 * order number, above thirteen — every Iranian layout from `9…` to `+98…` fits
 * inside that — it is a postal barcode.
 */
const PHONE_SEPARATORS = /[\s()+\-.]/g;
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 13;

function isPhoneShaped(value: string): boolean {
  const digits = value.replace(PHONE_SEPARATORS, "");
  return (
    ASCII_DIGITS.test(digits) &&
    digits.length >= MIN_PHONE_DIGITS &&
    digits.length <= MAX_PHONE_DIGITS
  );
}

/**
 * Payment references, resolved to order ids in one query.
 *
 * The settled gateway id reaches `contracts.external_id`, but only on success:
 * SnappPay writes it at finalization and the cancel path does not, and ZarinPal
 * stores its authority on the transaction row at checkout. So the orders an
 * operator actually looks up by reference — pending, stuck, failed — were the
 * ones the list could not find.
 *
 * Kept off the list query on purpose. Matching the transaction columns inline
 * would join them into the page query *and* into each of the seven tab counts;
 * resolving ids once costs a single bounded equality lookup that all eight
 * reuse. A reference is pasted whole, so equality is the right operator anyway,
 * and the shape gate — one unbroken alphanumeric token — keeps names and
 * separator-formatted phones from probing at all.
 */
const PAYMENT_REFERENCE = /^[A-Za-z0-9]{4,64}$/;
const MAX_PAYMENT_REFERENCE_MATCHES = 50;

async function resolveOrdersByPaymentReference(search: string): Promise<number[]> {
  if (!PAYMENT_REFERENCE.test(search)) return [];

  const rows = await strapi.query("api::contract-transaction.contract-transaction").findMany({
    where: {
      $or: [
        { external_id: { $eq: search } },
        { TrackId: { $eq: search } },
        { GatewayRefId: { $eq: search } },
      ],
    },
    select: ["id"],
    populate: { contract: { select: ["id"], populate: { order: { select: ["id"] } } } },
    limit: MAX_PAYMENT_REFERENCE_MATCHES,
  });

  const ids = new Set<number>();
  for (const row of (rows as any[]) || []) {
    const orderId = Number(row?.contract?.order?.id);
    if (Number.isSafeInteger(orderId) && orderId > 0) ids.add(orderId);
  }
  return [...ids];
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
  active: (now) => activeReserveGroupsWhere(now),
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
    const conditions: Record<string, unknown>[] = isPhoneShaped(normalized)
      ? customerPhoneSearchAlternatives(normalized, "owner")
      : [{ owner: { phone: { $containsi: normalized } } }];
    if (Number.isSafeInteger(asId)) {
      conditions.unshift({ rootOrder: { id: { $eq: asId } } });
    }
    return { $or: conditions };
  }
  return {
    $or: [
      { groupKey: { $containsi: search } },
      { ShippingBarcode: { $containsi: search } },
      // Same full-name split as the orders list; the board shows owner names the
      // same way and had the same defect.
      ...personNameSearchAlternatives(search, "owner"),
      recipientNameContains(search),
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
    const tab = String(body.tab || "all");
    if (!ORDER_TAB_KEYS.includes(tab as OrderTabKey)) {
      return rejectAdminListRequest(ctx, "Unsupported orders-list tab");
    }
    const sort = String(body.sort || "last-edited");
    if (!SORTS[sort]) {
      return rejectAdminListRequest(ctx, "Unsupported orders-list sort");
    }
    const criteria = await parseOrderListCriteria(ctx, body);
    if (!criteria) return;
    const where = orderWhereForTab(criteria.conditions, tab as OrderTabKey);
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
          delivery_address: { select: ["id", "FullName"] },
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
      hasSearch: Boolean(criteria.search),
      filterCount: criteria.filters.length,
      shippingMethodFilterCount: criteria.shippingMethodCodes.length,
    });
  },

  async counts(ctx) {
    const startedAt = Date.now();
    const body = ctx.request?.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return rejectAdminListRequest(ctx, "Request body must be an object");
    }

    const criteria = await parseOrderListCriteria(ctx, body);
    if (!criteria) return;

    const orderQuery = strapi.query("api::order.order");
    const reserveGroupQuery = strapi.query(RESERVE_GROUP_UID);
    const now = new Date();
    const [tabTotals, activeReserveGroups] = await Promise.all([
      Promise.all(
        ORDER_TAB_KEYS.map((tab) =>
          orderQuery.count({ where: orderWhereForTab(criteria.conditions, tab) }),
        ),
      ),
      reserveGroupQuery.count({ where: activeReserveGroupsWhere(now) }),
    ]);
    const counts = Object.fromEntries(
      ORDER_TAB_KEYS.map((tab, index) => [tab, Number(tabTotals[index]) || 0]),
    );

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data: {
        counts,
        activeReserveGroups: Number(activeReserveGroups) || 0,
      },
    };

    strapi.log.info("admin order counts completed", {
      durationMs: Date.now() - startedAt,
      hasSearch: Boolean(criteria.search),
      filterCount: criteria.filters.length,
      shippingMethodFilterCount: criteria.shippingMethodCodes.length,
    });
  },

  async shippingMethods(ctx) {
    const rows = await strapi.query("api::shipping.shipping").findMany({
      select: ["id", "Title", "Code", "SortOrder"],
      orderBy: [{ SortOrder: "asc" }, { id: "asc" }],
      limit: MAX_SHIPPING_METHOD_FILTERS,
    });
    const seen = new Set<string>();
    const data = ((rows as any[]) || []).flatMap((method) => {
      const code = String(method?.Code || method?.id || "").trim();
      if (!code || seen.has(code)) return [];
      seen.add(code);
      return [
        {
          code,
          title: String(method?.Title || `روش ارسال ${method?.id}`).trim(),
        },
      ];
    });

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = { data };
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
