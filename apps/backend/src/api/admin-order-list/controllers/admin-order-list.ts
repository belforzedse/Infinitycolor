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
};
