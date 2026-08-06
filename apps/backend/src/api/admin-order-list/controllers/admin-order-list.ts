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
  inprogress: { Status: { $in: ["Paying", "Started", "Shipment"] } },
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
      ShippingBarcode: order.ShippingBarcode ?? null,
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
      conditions.push({ contract: { external_id: { $containsi: search } } });
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
          "ShippingBarcode",
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
    const sanitizedRows = await sanitize.contentAPI.output(rows, schema, {
      auth: ctx.state.auth,
    });
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
