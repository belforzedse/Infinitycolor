import { sanitize } from "@strapi/utils";
import { paidOrdersCte, resolveJoins } from "../../report/services/product-analytics";
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
import { expandSearchTermVariants } from "../../../utils/searchTermVariants";

const MAX_CUSTOM_SORT_PRODUCTS = 50_000;

const FILTER_FIELDS: Record<string, AdminFilterDefinition> = {
  "[Title]": { path: ["Title"], type: "text" },
  "[Slug]": { path: ["Slug"], type: "text" },
  "[Status]": { path: ["Status"], type: "select" },
  "[ProductType]": { path: ["ProductType"], type: "select" },
  "[product_main_category][Title]": {
    path: ["product_main_category", "Title"],
    type: "text",
  },
  "[product_variations][SKU]": {
    path: ["product_variations", "SKU"],
    type: "text",
  },
  "[product_variations][Price]": {
    path: ["product_variations", "Price"],
    type: "number",
  },
  "[product_variations][DiscountPrice]": {
    path: ["product_variations", "DiscountPrice"],
    type: "number",
  },
  "[product_variations][product_stock][Count]": {
    path: ["product_variations", "product_stock", "Count"],
    type: "number",
  },
  "[createdAt]": { path: ["createdAt"], type: "date" },
  "[scheduledPublishAt]": { path: ["scheduledPublishAt"], type: "date" },
  "[LastEditedByAdminAt]": {
    path: ["LastEditedByAdminAt"],
    type: "date",
  },
};

const STANDARD_SORTS: Record<string, Array<Record<string, "asc" | "desc">>> = {
  "last-edited": [{ LastEditedByAdminAt: "desc" }, { id: "desc" }],
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
};
const CUSTOM_SORTS = new Set(["stock-asc", "stock-desc", "sales-asc", "sales-desc"]);

const PRODUCT_SELECT = [
  "id",
  "removedAt",
  "Title",
  "Status",
  "scheduledPublishAt",
  "scheduledPublishTimezone",
  "scheduledPublishLastAttemptAt",
  "scheduledPublishLastError",
  "scheduledPublishFailureKind",
  "ProductType",
  "AverageRating",
  "RatingCount",
  "createdAt",
  "updatedAt",
  "LastEditedByAdminAt",
];

const PRODUCT_POPULATE = {
  product_main_category: { select: ["id", "Title"] },
  product_variations: {
    select: ["id", "IsPublished", "SKU", "Price", "DiscountPrice"],
    populate: {
      product_stock: { select: ["id", "Count"] },
    },
  },
  CoverImage: {
    select: ["id", "name", "alternativeText", "width", "height", "formats", "url", "mime"],
  },
};

function rowsFromRaw(result: any): any[] {
  return result?.rows || result?.[0] || [];
}

function projectProduct(product: any) {
  const category = product.product_main_category;
  const coverImage = product.CoverImage;
  const variations = Array.isArray(product.product_variations) ? product.product_variations : [];

  return {
    id: product.id,
    attributes: {
      removedAt: product.removedAt ?? null,
      Title: product.Title ?? null,
      Status: product.Status ?? null,
      scheduledPublishAt: product.scheduledPublishAt ?? null,
      scheduledPublishTimezone: product.scheduledPublishTimezone ?? null,
      scheduledPublishLastAttemptAt: product.scheduledPublishLastAttemptAt ?? null,
      scheduledPublishLastError: product.scheduledPublishLastError ?? null,
      scheduledPublishFailureKind: product.scheduledPublishFailureKind ?? null,
      ProductType: product.ProductType ?? null,
      AverageRating:
        product.AverageRating === null || product.AverageRating === undefined
          ? null
          : Number(product.AverageRating),
      RatingCount:
        product.RatingCount === null || product.RatingCount === undefined
          ? null
          : Number(product.RatingCount),
      createdAt: product.createdAt ?? null,
      updatedAt: product.updatedAt ?? null,
      LastEditedByAdminAt: product.LastEditedByAdminAt ?? null,
      product_main_category: {
        data: category
          ? {
              id: category.id,
              attributes: { Title: category.Title ?? null },
            }
          : null,
      },
      product_variations: {
        data: variations.map((variation: any) => ({
          id: variation.id,
          attributes: {
            IsPublished: variation.IsPublished === true,
            SKU: variation.SKU ?? null,
            Price: variation.Price ?? null,
            DiscountPrice: variation.DiscountPrice ?? null,
            product_stock: {
              data: variation.product_stock
                ? {
                    id: variation.product_stock.id,
                    attributes: {
                      Count: Number(variation.product_stock.Count) || 0,
                    },
                  }
                : null,
            },
          },
        })),
      },
      CoverImage: {
        data: coverImage
          ? {
              id: coverImage.id,
              attributes: {
                name: coverImage.name ?? null,
                alternativeText: coverImage.alternativeText ?? null,
                width: coverImage.width ?? null,
                height: coverImage.height ?? null,
                formats: coverImage.formats ?? null,
                url: coverImage.url ?? null,
                mime: coverImage.mime ?? null,
              },
            }
          : null,
      },
    },
  };
}

async function rankedStockIds(allowedIds: number[], direction: "asc" | "desc") {
  if (allowedIds.length === 0) return [];
  const knex = strapi.db.connection;
  const result = await knex.raw(
    `SELECT p.id AS product_id, COALESCE(SUM(ps.count), 0)::bigint AS sort_value
     FROM products p
     LEFT JOIN product_variations_product_links pvpl ON pvpl.product_id = p.id
     LEFT JOIN product_variations pv ON pv.id = pvpl.product_variation_id
     LEFT JOIN product_variations_product_stock_links pvspl ON pvspl.product_variation_id = pv.id
     LEFT JOIN product_stocks ps ON ps.id = pvspl.product_stock_id
     WHERE p.id = ANY(string_to_array(?, ',')::integer[])
     GROUP BY p.id
     ORDER BY sort_value ${direction}, p.id ${direction}`,
    [allowedIds.join(",")],
  );
  return rowsFromRaw(result).map((row) => Number(row.product_id));
}

async function rankedSalesIds(allowedIds: number[], direction: "asc" | "desc") {
  if (allowedIds.length === 0) return [];
  const knex = strapi.db.connection;
  const joins = await resolveJoins(knex);
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);

  const result = await knex.raw(
    `WITH ${paidOrdersCte(joins)}
     SELECT p.id AS product_id, SUM(oi.count)::bigint AS sort_value
     FROM order_items oi
     ${joins.oiToOrder}
     ${joins.oiToVariation.join}
     ${joins.variationToProduct}
     JOIN paid_orders po ON po.order_id = o.id
     WHERE p.id = ANY(string_to_array(?, ',')::integer[])
     GROUP BY p.id
     ORDER BY sort_value ${direction}, p.id ${direction}`,
    [start, end, allowedIds.join(",")],
  );
  return rowsFromRaw(result).map((row) => Number(row.product_id));
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
    const removed = body.removed === true;
    const search = String(body.search ?? "").trim();
    if (search.length > MAX_ADMIN_SEARCH_LENGTH) {
      return rejectAdminListRequest(ctx, "search must contain at most 80 characters");
    }

    const sort = String(body.sort || "last-edited");
    if (!STANDARD_SORTS[sort] && !CUSTOM_SORTS.has(sort)) {
      return rejectAdminListRequest(ctx, "Unsupported products-list sort");
    }
    const filters = parseAdminFilters(ctx, body.filters, FILTER_FIELDS, "products-list");
    if (!filters) return;

    const conditions: Array<Record<string, unknown>> = [
      { removedAt: removed ? { $notNull: true } : { $null: true } },
      ...filters,
    ];
    // "W00288" must find the product whose title stores the code as "W 00288".
    const searchVariants = expandSearchTermVariants(search);
    if (searchVariants.length > 0) {
      conditions.push({
        $or: searchVariants.map((variant) => ({ Title: { $containsi: variant } })),
      });
    }
    const where = { $and: conditions };
    const productQuery = strapi.query("api::product.product");
    const recycleCountPromise = productQuery.count({
      where: { removedAt: { $notNull: true } },
    });

    let rows: any[] = [];
    let total = 0;
    if (STANDARD_SORTS[sort]) {
      [rows, total] = await Promise.all([
        productQuery.findMany({
          where,
          select: PRODUCT_SELECT,
          populate: PRODUCT_POPULATE,
          orderBy: STANDARD_SORTS[sort],
          offset: (page - 1) * pageSize,
          limit: pageSize,
        }),
        productQuery.count({ where }),
      ]);
    } else {
      const [allowedRows, filteredTotal] = await Promise.all([
        productQuery.findMany({
          where,
          select: ["id"],
          orderBy: { id: "asc" },
          limit: MAX_CUSTOM_SORT_PRODUCTS + 1,
        }),
        productQuery.count({ where }),
      ]);
      if (allowedRows.length > MAX_CUSTOM_SORT_PRODUCTS) {
        return rejectAdminListRequest(
          ctx,
          `Custom product sorting is limited to ${MAX_CUSTOM_SORT_PRODUCTS} matching products`,
        );
      }

      const direction = sort.endsWith("asc") ? "asc" : "desc";
      const allowedIds = allowedRows.map((row: any) => Number(row.id));
      const rankedIds = sort.startsWith("stock")
        ? await rankedStockIds(allowedIds, direction)
        : await rankedSalesIds(allowedIds, direction);
      total = sort.startsWith("sales") ? rankedIds.length : filteredTotal;
      const pageIds = rankedIds.slice((page - 1) * pageSize, page * pageSize);
      if (pageIds.length > 0) {
        rows = await productQuery.findMany({
          where: { id: { $in: pageIds } },
          select: PRODUCT_SELECT,
          populate: PRODUCT_POPULATE,
          limit: pageIds.length,
        });
        const rank = new Map(pageIds.map((id, index) => [id, index]));
        rows.sort((left, right) => rank.get(Number(left.id))! - rank.get(Number(right.id))!);
      }
    }

    const recycleCount = await recycleCountPromise;
    const schema = strapi.contentType("api::product.product");
    const sanitizedRows = await sanitize.contentAPI.output(rows, schema, {
      auth: ctx.state.auth,
    });
    const data = (sanitizedRows as any[]).map(projectProduct);

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data,
      meta: {
        pagination: adminPagination(page, pageSize, total),
        recycleCount,
      },
    };

    strapi.log.info("admin products list completed", {
      durationMs: Date.now() - startedAt,
      page,
      pageSize,
      returned: data.length,
      total,
      removed,
      sort,
      hasSearch: Boolean(search),
      filterCount: filters.length,
    });
  },
};
