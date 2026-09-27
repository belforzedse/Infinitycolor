import { paidOrdersCte, resolveJoins } from "../../report/services/product-analytics";
import {
  DEFAULT_ADMIN_PAGE_SIZE,
  MAX_ADMIN_PAGE,
  MAX_ADMIN_PAGE_SIZE,
  MAX_ADMIN_SEARCH_LENGTH,
  escapeAdminLike,
  parseAdminFilters,
  positiveAdminInteger,
  rejectAdminListRequest,
  type AdminFilterDefinition,
} from "../../../utils/admin-list-query";
import { expandSearchTermVariants } from "../../../utils/searchTermVariants";
import { getProductAvailabilityJoinContext } from "../../../utils/productAvailability";

// knex is a transitive dependency without its own types entry here; the rest of
// the backend types it loosely the same way (report/services/product-analytics.ts).
type Knex = any;
type KnexQuery = any;

/**
 * The admin Products query model.
 *
 * One criteria object drives both the table (`query`) and the lifecycle tab
 * badges (`counts`), so a badge always counts the population its tab would
 * show. Every criterion is applied in SQL; nothing is filtered in the browser.
 *
 *  - `view` is the lifecycle tab. Publication and deletion are separate
 *    dimensions: "all" is every product not in Trash, whatever its status.
 *  - search, quick filters and advanced filters narrow every tab alike, and
 *    `counts` applies them to every bucket while leaving the tab out — the
 *    same semantics as the Orders list.
 *  - Sorting is an allowlist of fixed SQL expressions. Request input never
 *    reaches SQL except as bound values.
 */

export const PRODUCT_UID = "api::product.product";

export const PRODUCT_LIST_VIEWS = ["all", "published", "drafts", "scheduled", "trash"] as const;
export type ProductListView = (typeof PRODUCT_LIST_VIEWS)[number];

export const PRODUCT_LIST_SORTS = [
  "last-edited",
  "newest",
  "oldest",
  "updated",
  "title",
  "published",
  "scheduled-asc",
  "scheduled-desc",
  "trashed-desc",
  "trashed-asc",
  "stock-asc",
  "stock-desc",
  "sales-asc",
  "sales-desc",
] as const;
export type ProductListSort = (typeof PRODUCT_LIST_SORTS)[number];

export const DEFAULT_SORT_BY_VIEW: Record<ProductListView, ProductListSort> = {
  all: "last-edited",
  published: "last-edited",
  drafts: "last-edited",
  scheduled: "scheduled-asc",
  trash: "trashed-desc",
};

export const PRODUCT_TYPES = ["Simple", "Variable"] as const;
export const STOCK_STATES = ["in", "out"] as const;

export const FILTER_FIELDS: Record<string, AdminFilterDefinition> = {
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
  "[PublishedAt]": { path: ["PublishedAt"], type: "date" },
  "[removedAt]": { path: ["removedAt"], type: "date" },
};

export type ProductListCriteria = {
  view: ProductListView;
  page: number;
  pageSize: number;
  sort: ProductListSort;
  search: string;
  categoryId: number | null;
  stock: (typeof STOCK_STATES)[number] | null;
  productType: (typeof PRODUCT_TYPES)[number] | null;
  filters: Array<Record<string, unknown>>;
};

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * Validates the request body. Returns null after answering 400 for anything
 * malformed or unsupported — an unknown view or sort is an error, not a
 * silent fallback that would show the admin a different list than they asked for.
 */
export function parseProductListCriteria(ctx: any, body: any): ProductListCriteria | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return rejectAdminListRequest(ctx, "Request body must be an object");
  }

  // `removed: true` is the pre-lifecycle recycle-bin flag; it still means Trash.
  const rawView = body.view ?? (body.removed === true ? "trash" : "all");
  if (!isOneOf(PRODUCT_LIST_VIEWS, rawView)) {
    return rejectAdminListRequest(ctx, "Unsupported products-list view");
  }
  const view = rawView;

  const rawSort = body.sort === undefined || body.sort === null || body.sort === ""
    ? DEFAULT_SORT_BY_VIEW[view]
    : body.sort;
  if (!isOneOf(PRODUCT_LIST_SORTS, rawSort)) {
    return rejectAdminListRequest(ctx, "Unsupported products-list sort");
  }

  const search = String(body.search ?? "").trim();
  if (search.length > MAX_ADMIN_SEARCH_LENGTH) {
    return rejectAdminListRequest(ctx, "search must contain at most 80 characters");
  }

  let categoryId: number | null = null;
  if (body.categoryId !== undefined && body.categoryId !== null && body.categoryId !== "") {
    categoryId = Number(body.categoryId);
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
      return rejectAdminListRequest(ctx, "categoryId must be a positive integer");
    }
  }

  let stock: ProductListCriteria["stock"] = null;
  if (body.stock !== undefined && body.stock !== null && body.stock !== "") {
    if (!isOneOf(STOCK_STATES, body.stock)) {
      return rejectAdminListRequest(ctx, "Unsupported stock filter");
    }
    stock = body.stock;
  }

  let productType: ProductListCriteria["productType"] = null;
  if (body.productType !== undefined && body.productType !== null && body.productType !== "") {
    if (!isOneOf(PRODUCT_TYPES, body.productType)) {
      return rejectAdminListRequest(ctx, "Unsupported product type filter");
    }
    productType = body.productType;
  }

  const filters = parseAdminFilters(ctx, body.filters, FILTER_FIELDS, "products-list");
  if (!filters) return null;

  return {
    view,
    page: Math.min(positiveAdminInteger(body.page, 1), MAX_ADMIN_PAGE),
    pageSize: Math.min(positiveAdminInteger(body.pageSize, DEFAULT_ADMIN_PAGE_SIZE), MAX_ADMIN_PAGE_SIZE),
    sort: rawSort,
    search,
    categoryId,
    stock,
    productType,
    filters,
  };
}

/* --------------------------------------------------------------- predicates */

/**
 * The lifecycle buckets as SQL over alias `p`. Drafts take every non-trashed
 * row that is neither published nor scheduled — including legacy rows whose
 * status is NULL — so All always equals Published + Drafts + Scheduled.
 */
export const VIEW_SQL: Record<ProductListView, string> = {
  all: "p.removed_at IS NULL",
  published: "p.removed_at IS NULL AND p.status = 'Active'",
  drafts:
    "p.removed_at IS NULL AND (p.status IS NULL OR p.status NOT IN ('Active', 'Scheduled'))",
  scheduled: "p.removed_at IS NULL AND p.status = 'Scheduled'",
  trash: "p.removed_at IS NOT NULL AND p.purged_at IS NULL",
};

type Joins = ReturnType<typeof getProductAvailabilityJoinContext>;

function linkTable(strapi: any, attribute: string, fallback: { table: string; joinColumn: string; inverseColumn: string }) {
  const meta = strapi?.db?.metadata?.get?.(PRODUCT_UID)?.attributes?.[attribute]?.joinTable;
  return {
    table: String(meta?.name || fallback.table),
    joinColumn: String(meta?.joinColumn?.name || fallback.joinColumn),
    inverseColumn: String(meta?.inverseJoinColumn?.name || fallback.inverseColumn),
  };
}

/** Identifiers come from Strapi metadata, never from the request. */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

function stockSumSql(joins: Joins): string {
  return `(
    SELECT COALESCE(SUM(COALESCE(ps.count, 0)), 0)
    FROM ${ident(joins.productVariationProductLinkTable)} AS pvl
    JOIN ${ident(joins.productVariationStockLinkTable)} AS psl
      ON psl.${ident(joins.productVariationStockJoinColumn)} = pvl.${ident(joins.productVariationProductJoinColumn)}
    JOIN product_stocks AS ps ON ps.id = psl.${ident(joins.productVariationStockInverseColumn)}
    WHERE pvl.${ident(joins.productVariationProductInverseColumn)} = p.id
  )`;
}

function inStockExistsSql(joins: Joins): string {
  return `EXISTS (
    SELECT 1
    FROM ${ident(joins.productVariationProductLinkTable)} AS pvl
    JOIN ${ident(joins.productVariationStockLinkTable)} AS psl
      ON psl.${ident(joins.productVariationStockJoinColumn)} = pvl.${ident(joins.productVariationProductJoinColumn)}
    JOIN product_stocks AS ps ON ps.id = psl.${ident(joins.productVariationStockInverseColumn)}
    WHERE pvl.${ident(joins.productVariationProductInverseColumn)} = p.id
      AND COALESCE(ps.count, 0) > 0
  )`;
}

/**
 * The base query every list, count and total shares: products narrowed by the
 * secondary criteria, before the lifecycle view is applied.
 */
export function buildProductListBase(strapi: any, criteria: ProductListCriteria): KnexQuery {
  const knex: Knex = strapi.db.connection;
  const joins = getProductAvailabilityJoinContext(strapi);
  const query = knex({ p: "products" });

  if (criteria.search) {
    const variants = expandSearchTermVariants(criteria.search);
    const skuTerm = `%${escapeAdminLike(criteria.search)}%`;
    const idMatch = criteria.search.replace(/^#/, "");
    const numericId = /^\d{1,10}$/.test(idMatch) ? Number(idMatch) : null;
    query.where((group) => {
      // "W00288" must find the product whose title stores the code as "W 00288".
      for (const variant of variants) {
        group.orWhereRaw("p.title ILIKE ?", [`%${escapeAdminLike(variant)}%`]);
      }
      group.orWhereRaw(
        `EXISTS (
          SELECT 1
          FROM ${ident(joins.productVariationProductLinkTable)} AS pvl
          JOIN product_variations AS pv ON pv.id = pvl.${ident(joins.productVariationProductJoinColumn)}
          WHERE pvl.${ident(joins.productVariationProductInverseColumn)} = p.id
            AND pv.sku ILIKE ?
        )`,
        [skuTerm],
      );
      if (numericId !== null && Number.isSafeInteger(numericId)) {
        group.orWhere("p.id", numericId);
      }
    });
  }

  if (criteria.categoryId) {
    const main = linkTable(strapi, "product_main_category", {
      table: "products_product_main_category_links",
      joinColumn: "product_id",
      inverseColumn: "product_category_id",
    });
    const others = linkTable(strapi, "product_other_categories", {
      table: "products_product_other_categories_links",
      joinColumn: "product_id",
      inverseColumn: "product_category_id",
    });
    query.where((group) => {
      group
        .whereRaw(
          `EXISTS (SELECT 1 FROM ${ident(main.table)} AS mcl WHERE mcl.${ident(main.joinColumn)} = p.id AND mcl.${ident(main.inverseColumn)} = ?)`,
          [criteria.categoryId],
        )
        .orWhereRaw(
          `EXISTS (SELECT 1 FROM ${ident(others.table)} AS ocl WHERE ocl.${ident(others.joinColumn)} = p.id AND ocl.${ident(others.inverseColumn)} = ?)`,
          [criteria.categoryId],
        );
    });
  }

  if (criteria.stock === "in") query.whereRaw(inStockExistsSql(joins));
  if (criteria.stock === "out") query.whereRaw(`NOT ${inStockExistsSql(joins)}`);
  if (criteria.productType) query.where("p.product_type", criteria.productType);

  if (criteria.filters.length > 0) {
    // Advanced filters keep the Strapi where-shape the rest of the admin uses
    // (`admin-list-query.ts`); Strapi compiles them — joins included — into an
    // id subquery, so relation paths never have to be re-implemented here.
    const filtered = strapi.db
      .queryBuilder(PRODUCT_UID)
      .select("id")
      .where({ $and: criteria.filters })
      .getKnexQuery();
    query.whereIn("p.id", filtered);
  }

  return query;
}

type SortPlan = { sql: string; needsSales: boolean };

function sortPlan(sort: ProductListSort, joins: Joins): SortPlan {
  switch (sort) {
    case "last-edited":
      return { sql: "p.last_edited_by_admin_at DESC, p.id DESC", needsSales: false };
    case "newest":
      return { sql: "p.created_at DESC, p.id DESC", needsSales: false };
    case "oldest":
      return { sql: "p.created_at ASC, p.id ASC", needsSales: false };
    case "updated":
      return { sql: "p.updated_at DESC, p.id DESC", needsSales: false };
    case "title":
      return { sql: "p.title ASC, p.id ASC", needsSales: false };
    case "published":
      return { sql: "p.published_at DESC NULLS LAST, p.id DESC", needsSales: false };
    case "scheduled-asc":
      return { sql: "p.scheduled_publish_at ASC NULLS LAST, p.id ASC", needsSales: false };
    case "scheduled-desc":
      return { sql: "p.scheduled_publish_at DESC NULLS LAST, p.id DESC", needsSales: false };
    case "trashed-desc":
      return { sql: "p.removed_at DESC NULLS LAST, p.id DESC", needsSales: false };
    case "trashed-asc":
      return { sql: "p.removed_at ASC NULLS LAST, p.id ASC", needsSales: false };
    case "stock-asc":
      return { sql: `${stockSumSql(joins)} ASC, p.id ASC`, needsSales: false };
    case "stock-desc":
      return { sql: `${stockSumSql(joins)} DESC, p.id DESC`, needsSales: false };
    case "sales-asc":
      return { sql: "COALESCE(product_sales.quantity, 0) ASC, p.id ASC", needsSales: true };
    case "sales-desc":
      return { sql: "COALESCE(product_sales.quantity, 0) DESC, p.id DESC", needsSales: true };
  }
}

/** Units sold over the last 30 days, by the same paid-order rule as the sales reports. */
async function attachSales(strapi: any, query: KnexQuery): Promise<void> {
  const knex: Knex = strapi.db.connection;
  const joins = await resolveJoins(knex);
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  query
    .with(
      "product_sales",
      knex.raw(
        `WITH ${paidOrdersCte(joins)}
         SELECT p.id AS product_id, SUM(oi.count)::bigint AS quantity
         FROM order_items oi
         ${joins.oiToOrder}
         ${joins.oiToVariation.join}
         ${joins.variationToProduct}
         JOIN paid_orders po ON po.order_id = o.id
         GROUP BY p.id`,
        [start, end],
      ),
    )
    .leftJoin("product_sales", "product_sales.product_id", "p.id");
}

export async function findProductListPage(
  strapi: any,
  criteria: ProductListCriteria,
): Promise<{ ids: number[]; total: number }> {
  const joins = getProductAvailabilityJoinContext(strapi);
  const plan = sortPlan(criteria.sort, joins);
  const idQuery = buildProductListBase(strapi, criteria)
    .whereRaw(VIEW_SQL[criteria.view])
    .select("p.id")
    .orderByRaw(plan.sql)
    .limit(criteria.pageSize)
    .offset((criteria.page - 1) * criteria.pageSize);
  if (plan.needsSales) await attachSales(strapi, idQuery);

  const totalQuery = buildProductListBase(strapi, criteria)
    .whereRaw(VIEW_SQL[criteria.view])
    .count({ total: "p.id" })
    .first();

  const [rows, totalRow] = await Promise.all([idQuery, totalQuery]);
  return {
    ids: (rows as Array<{ id: number }>).map((row) => Number(row.id)),
    total: Number((totalRow as { total?: string | number } | undefined)?.total || 0),
  };
}

export type ProductLifecycleCounts = Record<ProductListView, number>;

/** All five tab badges in one aggregate statement. */
export async function countProductListViews(
  strapi: any,
  criteria: ProductListCriteria,
): Promise<ProductLifecycleCounts> {
  const knex: Knex = strapi.db.connection;
  const columns = PRODUCT_LIST_VIEWS.map((view) =>
    knex.raw(`COUNT(*) FILTER (WHERE ${VIEW_SQL[view]})::bigint AS ??`, [view]),
  );
  const row = (await buildProductListBase(strapi, criteria).select(columns).first()) as
    | Record<string, string | number>
    | undefined;
  return Object.fromEntries(
    PRODUCT_LIST_VIEWS.map((view) => [view, Number(row?.[view] || 0)]),
  ) as ProductLifecycleCounts;
}
