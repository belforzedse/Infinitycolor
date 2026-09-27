import { PRODUCT_STOCK_POPULATE_FIELDS } from "../../cart/services/lib/stock";
import {
  buildProductAvailabilityExistsSql,
  getProductAvailabilityJoinContext,
} from "../../../utils/productAvailability";
import { expandSearchTermVariants } from "../../../utils/searchTermVariants";

export const PRODUCT_CARD_FIELDS = [
  "id",
  "Title",
  "Slug",
  "Status",
  "ProductType",
  "IsSimpleProduct",
  "SeenCount",
  "AverageRating",
  "RatingCount",
  "createdAt",
] as const;

export const PRODUCT_CARD_POPULATE = {
  CoverImage: {
    fields: ["url", "alternativeText", "formats", "mime", "width", "height"],
  },
  product_main_category: {
    fields: ["Title", "Slug"],
  },
  product_variations: {
    fields: ["IsPublished", "Price", "DiscountPrice", "SKU"],
    populate: {
      product_stock: {
        fields: [...PRODUCT_STOCK_POPULATE_FIELDS],
      },
      product_variation_color: {
        fields: ["Title", "ColorCode"],
      },
      general_discounts: {
        fields: ["Amount"],
      },
    },
  },
} as const;

export type FindProductCardsParams = {
  filters?: Record<string, unknown>;
  sort?: unknown;
  availability?: unknown;
  price?: {
    min?: unknown;
    max?: unknown;
  };
  hasDiscount?: unknown;
  // Client-requested hint that this is the exact unfiltered default-sort PLP view. Only
  // honored when the `hideDiscountedOnDefaultNewestPlp` site setting is also enabled --
  // see resolveExcludeDiscountFlag -- so the actual on/off control stays admin-side.
  excludeDiscount?: unknown;
  // Client-requested hint naming a curated storefront section ("newest" | "popular" |
  // "discount"). Resolved and validated by product.ts's findProductCards -- which turns
  // it into curatedProductIds below -- before it ever reaches this module.
  curated?: unknown;
  // Resolved, ordered product ids manually curated for the current section. When
  // non-empty, these are surfaced first in this exact order (stably partitioned by
  // stock, see applyAvailabilityAwareOrder) ahead of the normal algorithmic ordering.
  curatedProductIds?: number[];
  requireCoverImage?: unknown;
  pagination?: {
    page?: number | string;
    pageSize?: number | string;
    limit?: number | string;
    start?: number | string;
    withCount?: boolean | string | number;
  };
};

export type OrderedProductIdQueryParams = FindProductCardsParams & {
  q?: string;
  isAdmin?: boolean;
};

export function parseQuerySortKey(sort: unknown): string | undefined {
  if (typeof sort === "string") {
    return sort;
  }
  if (Array.isArray(sort) && typeof sort[0] === "string") {
    return sort[0];
  }
  return undefined;
}

export function buildRatingOrderClause(sortKey: string | undefined): string | null {
  const [field, rawDirection] = (sortKey?.trim() || "").split(":");
  if (field !== "AverageRating") return null;
  const direction = rawDirection === "asc" ? "ASC" : "DESC";
  return `p.average_rating ${direction} NULLS LAST`;
}

export function parseFindProductCardsPagination(
  pagination: FindProductCardsParams["pagination"] = {},
) {
  const limit = Math.min(
    100,
    Math.max(1, parseInt(String(pagination.limit ?? pagination.pageSize ?? 25), 10)),
  );
  const page = Math.max(1, parseInt(String(pagination.page ?? 1), 10));
  const start =
    pagination.start !== undefined
      ? Math.max(0, parseInt(String(pagination.start), 10))
      : (page - 1) * limit;
  const withCount =
    pagination.withCount === false ||
    pagination.withCount === "false" ||
    pagination.withCount === 0 ||
    pagination.withCount === "0"
      ? false
      : true;

  return { limit, page, start, withCount };
}

export function parseEntityServiceSortKey(
  sortKey: string | undefined,
): Array<Record<string, "asc" | "desc">> {
  const normalized = sortKey?.trim() || "createdAt:desc";
  const [field, direction] = normalized.split(":");
  if (!field) {
    return [{ createdAt: "desc" }];
  }

  return [{ [field]: direction === "asc" ? "asc" : "desc" }];
}

const PRODUCT_COLUMN_MAP: Record<string, string> = {
  id: "id",
  Title: "title",
  Slug: "slug",
  Status: "status",
  ProductType: "product_type",
  IsSimpleProduct: "is_simple_product",
  SeenCount: "seen_count",
  AverageRating: "average_rating",
  RatingCount: "rating_count",
  createdAt: "created_at",
  updatedAt: "updated_at",
  removedAt: "removed_at",
  // Staff catalog reads exclude permanently deleted tombstones with this.
  purgedAt: "purged_at",
  LastEditedByAdminAt: "last_edited_by_admin_at",
  PublishedAt: "published_at",
};

const CATEGORY_COLUMN_MAP: Record<string, string> = {
  id: "id",
  Title: "title",
  Slug: "slug",
};

const VARIATION_COLUMN_MAP: Record<string, string> = {
  id: "id",
  IsPublished: "is_published",
  Price: "price",
  DiscountPrice: "discount_price",
  SKU: "sku",
};

const STOCK_COLUMN_MAP: Record<string, string> = {
  Count: "count",
  reservedCount: "reserved_count",
  ReservedCount: "reserved_count",
};

const VARIATION_RELATION_COLUMN_MAP: Record<string, Record<string, string>> = {
  product_variation_size: {
    id: "id",
    Title: "title",
  },
  product_variation_color: {
    id: "id",
    Title: "title",
    ColorCode: "color_code",
  },
  product_variation_model: {
    id: "id",
    Title: "title",
  },
};

const VARIATION_RELATION_TABLE_MAP: Record<string, string> = {
  product_variation_size: "product_variation_sizes",
  product_variation_color: "product_variation_colors",
  product_variation_model: "product_variation_models",
};

const toArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.includes(",")) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [value];
};

const parseBooleanString = (value: unknown): boolean | undefined => {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return undefined;
};

const toFiniteNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export const isEnabledCardParam = (value: unknown): boolean =>
  value === true || value === "true" || value === 1 || value === "1";

export function parseCardPriceFilter(price: FindProductCardsParams["price"]) {
  if (!price || typeof price !== "object") return {};
  return {
    min: toFiniteNumber(price.min),
    max: toFiniteNumber(price.max),
  };
}

type JoinTableInfo = {
  table: string;
  joinColumn: string;
  inverseColumn: string;
};

const readJoinTable = (
  metadata: any,
  attributeName: string,
  fallback: JoinTableInfo,
): JoinTableInfo => {
  const joinTable = metadata?.attributes?.[attributeName]?.joinTable;
  return {
    table: joinTable?.name || fallback.table,
    joinColumn: joinTable?.joinColumn?.name || fallback.joinColumn,
    inverseColumn: joinTable?.inverseJoinColumn?.name || fallback.inverseColumn,
  };
};

const getVariationRelationJoinInfo = (strapi: any, relation: string): JoinTableInfo => {
  const variationMetadata = strapi?.db?.metadata?.get?.("api::product-variation.product-variation");
  const suffix = relation.replace(/^product_variation_/, "");
  return readJoinTable(variationMetadata, relation, {
    table: `product_variations_product_variation_${suffix}_links`,
    joinColumn: "product_variation_id",
    inverseColumn: `product_variation_${suffix}_id`,
  });
};

const getGeneralDiscountVariationJoinInfo = (strapi: any): JoinTableInfo => {
  const discountMetadata = strapi?.db?.metadata?.get?.("api::general-discount.general-discount");
  return readJoinTable(discountMetadata, "product_variations", {
    table: "general_discounts_product_variations_links",
    joinColumn: "general_discount_id",
    inverseColumn: "product_variation_id",
  });
};

const buildProductCardDisplayPriceSql = (knex: any, strapi: any, productAlias = "p"): any => {
  const ctx = getProductAvailabilityJoinContext(strapi);
  const discountJoin = getGeneralDiscountVariationJoinInfo(strapi);

  return knex.raw(
    `(
      SELECT MIN(
        CASE
          WHEN COALESCE(gd.amount, 0)::numeric > 0
          THEN GREATEST(
            0,
            ROUND(COALESCE(pv.price, 0)::numeric * (1 - COALESCE(gd.amount, 0)::numeric / 100))
          )
          WHEN COALESCE(pv.discount_price, 0)::numeric > 0
            AND COALESCE(pv.discount_price, 0)::numeric < COALESCE(pv.price, 0)::numeric
          THEN COALESCE(pv.discount_price, 0)::numeric
          ELSE COALESCE(pv.price, 0)::numeric
        END
      )
      FROM ?? AS pv
      INNER JOIN ?? AS pv_product_link
        ON pv_product_link.?? = pv.id
      LEFT JOIN (
        SELECT ?? AS product_variation_id, MAX(COALESCE(gd.amount, 0)) AS amount
        FROM ?? AS gd_pv_link
        INNER JOIN ?? AS gd
          ON gd.id = ??
        WHERE gd.removed_at IS NULL
          AND COALESCE(gd.amount, 0) > 0
        GROUP BY ??
      ) AS gd
        ON gd.product_variation_id = pv.id
      WHERE pv_product_link.?? = ??.id
        AND pv.is_published = TRUE
        AND COALESCE(pv.price, 0)::numeric > 0
    )`,
    [
      "product_variations",
      ctx.productVariationProductLinkTable,
      ctx.productVariationProductJoinColumn,
      `gd_pv_link.${discountJoin.inverseColumn}`,
      discountJoin.table,
      "general_discounts",
      `gd_pv_link.${discountJoin.joinColumn}`,
      `gd_pv_link.${discountJoin.inverseColumn}`,
      ctx.productVariationProductInverseColumn,
      productAlias,
    ],
  );
};

const addScalarCondition = (query: any, qualifiedColumn: string, condition: unknown) => {
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    for (const [operator, value] of Object.entries(condition as Record<string, unknown>)) {
      switch (operator) {
        case "$eq":
          query.where(qualifiedColumn, value);
          break;
        case "$ne":
          query.whereNot(qualifiedColumn, value);
          break;
        case "$in":
          query.whereIn(qualifiedColumn, toArray(value));
          break;
        case "$notIn":
          query.whereNotIn(qualifiedColumn, toArray(value));
          break;
        case "$gt":
          query.where(qualifiedColumn, ">", value);
          break;
        case "$gte":
          query.where(qualifiedColumn, ">=", value);
          break;
        case "$lt":
          query.where(qualifiedColumn, "<", value);
          break;
        case "$lte":
          query.where(qualifiedColumn, "<=", value);
          break;
        case "$containsi": {
          // Product codes live inside the title with a space the shopper never
          // types ("W 00288" vs "W00288"), so match every spelling of the term.
          const raw = String(value);
          const variants = expandSearchTermVariants(raw);
          const patterns = variants.length > 0 ? variants : [raw];
          query.where(function containsiGroup(this: any) {
            for (const pattern of patterns) {
              this.orWhereRaw("LOWER(??) LIKE LOWER(?)", [qualifiedColumn, `%${pattern}%`]);
            }
          });
          break;
        }
        case "$contains":
          query.where(qualifiedColumn, "like", `%${String(value)}%`);
          break;
        case "$null": {
          const isNull = parseBooleanString(value);
          if (isNull === false) query.whereNotNull(qualifiedColumn);
          else query.whereNull(qualifiedColumn);
          break;
        }
        default:
          break;
      }
    }
    return;
  }

  query.where(qualifiedColumn, condition);
};

const applyVariationRelationFilter = (
  query: any,
  strapi: any,
  relation: string,
  filter: Record<string, unknown>,
) => {
  const relatedTable = VARIATION_RELATION_TABLE_MAP[relation];
  const columnMap = VARIATION_RELATION_COLUMN_MAP[relation];
  if (!relatedTable || !columnMap) return;

  const join = getVariationRelationJoinInfo(strapi, relation);
  const linkAlias = `${relation}_link`;
  const relatedAlias = `${relation}_entity`;

  query
    .innerJoin(`${join.table} as ${linkAlias}`, `${linkAlias}.${join.joinColumn}`, "pv.id")
    .innerJoin(
      `${relatedTable} as ${relatedAlias}`,
      `${relatedAlias}.id`,
      `${linkAlias}.${join.inverseColumn}`,
    );

  for (const [field, condition] of Object.entries(filter)) {
    const column = columnMap[field];
    if (column) addScalarCondition(query, `${relatedAlias}.${column}`, condition);
  }
};

const applyCategoryFilter = (
  knex: any,
  query: any,
  relation: "product_main_category" | "product_other_categories",
  filter: Record<string, unknown>,
) => {
  const linkTable =
    relation === "product_main_category"
      ? "products_product_main_category_links"
      : "products_product_other_categories_links";

  query.whereExists(function categoryExists(this: any) {
    this.select(knex.raw("1"))
      .from(`${linkTable} as pc_link`)
      .innerJoin("product_categories as pc", "pc.id", "pc_link.product_category_id")
      .whereRaw("pc_link.product_id = p.id");

    for (const [field, condition] of Object.entries(filter)) {
      const column = CATEGORY_COLUMN_MAP[field];
      if (column) addScalarCondition(this, `pc.${column}`, condition);
    }
  });
};

const applyVariationFilter = (
  knex: any,
  query: any,
  strapi: any,
  filter: Record<string, unknown>,
) => {
  const ctx = getProductAvailabilityJoinContext(strapi);

  query.whereExists(function variationExists(this: any) {
    this.select(knex.raw("1"))
      .from("product_variations as pv")
      .innerJoin(
        `${ctx.productVariationProductLinkTable} as pv_product_link`,
        `pv_product_link.${ctx.productVariationProductJoinColumn}`,
        "pv.id",
      )
      .whereRaw(`pv_product_link.${ctx.productVariationProductInverseColumn} = p.id`);

    const stockFilter = filter.product_stock;
    if (stockFilter && typeof stockFilter === "object") {
      this.innerJoin(
        `${ctx.productVariationStockLinkTable} as pv_stock_link`,
        `pv_stock_link.${ctx.productVariationStockJoinColumn}`,
        "pv.id",
      ).innerJoin(
        "product_stocks as ps",
        "ps.id",
        `pv_stock_link.${ctx.productVariationStockInverseColumn}`,
      );
    }

    for (const [field, condition] of Object.entries(filter)) {
      if (field === "product_stock") {
        const stockConditions = condition as Record<string, unknown>;
        for (const [stockField, stockCondition] of Object.entries(stockConditions)) {
          const column = STOCK_COLUMN_MAP[stockField];
          if (column) addScalarCondition(this, `ps.${column}`, stockCondition);
        }
        continue;
      }

      const column = VARIATION_COLUMN_MAP[field];
      if (column) addScalarCondition(this, `pv.${column}`, condition);

      if (
        (field === "product_variation_size" ||
          field === "product_variation_color" ||
          field === "product_variation_model") &&
        condition &&
        typeof condition === "object"
      ) {
        applyVariationRelationFilter(this, strapi, field, condition as Record<string, unknown>);
      }
    }
  });
};

export const applyProductFilters = (
  knex: any,
  query: any,
  strapi: any,
  filters: Record<string, unknown> | undefined,
) => {
  if (!filters || Object.keys(filters).length === 0) return;

  const applyFilterObject = (builder: any, filterObject: Record<string, unknown>) => {
    for (const [field, condition] of Object.entries(filterObject)) {
      if (field === "$and" && Array.isArray(condition)) {
        builder.where(function andGroup(this: any) {
          for (const item of condition) {
            if (item && typeof item === "object") {
              this.where(function nestedAnd(this: any) {
                applyFilterObject(this, item as Record<string, unknown>);
              });
            }
          }
        });
        continue;
      }

      if (field === "$or" && Array.isArray(condition)) {
        builder.where(function orGroup(this: any) {
          for (const item of condition) {
            if (item && typeof item === "object") {
              this.orWhere(function nestedOr(this: any) {
                applyFilterObject(this, item as Record<string, unknown>);
              });
            }
          }
        });
        continue;
      }

      if (field === "product_variations" && condition && typeof condition === "object") {
        applyVariationFilter(knex, builder, strapi, condition as Record<string, unknown>);
        continue;
      }

      if (
        (field === "product_main_category" || field === "product_other_categories") &&
        condition &&
        typeof condition === "object"
      ) {
        applyCategoryFilter(knex, builder, field, condition as Record<string, unknown>);
        continue;
      }

      const column = PRODUCT_COLUMN_MAP[field];
      if (column) {
        addScalarCondition(builder, `p.${column}`, condition);
      }
    }
  };

  applyFilterObject(query, filters);
};

const applyAvailabilityOnlyFilter = (knex: any, query: any, strapi: any, availability: unknown) => {
  if (availability !== "in-stock" && availability !== "available" && availability !== true) return;
  const ctx = getProductAvailabilityJoinContext(strapi);
  query.whereRaw(buildProductAvailabilityExistsSql(knex, ctx, "p").toQuery());
};

const applyDisplayPriceFilter = (
  knex: any,
  query: any,
  strapi: any,
  price: FindProductCardsParams["price"],
) => {
  const { min, max } = parseCardPriceFilter(price);
  if (min === undefined && max === undefined) return;

  const priceSql = buildProductCardDisplayPriceSql(knex, strapi, "p").toQuery();

  query.whereRaw(`${priceSql} IS NOT NULL`);
  if (min !== undefined) query.whereRaw(`${priceSql} >= ?`, [min]);
  if (max !== undefined) query.whereRaw(`${priceSql} <= ?`, [max]);
};

const applyRequireCoverImageFilter = (query: any, requireCoverImage: unknown) => {
  if (!isEnabledCardParam(requireCoverImage)) return;

  query.whereExists(function coverImageExists(this: any) {
    this.select(1)
      .from("files_related_morphs as frm")
      .innerJoin("files as f", "f.id", "frm.file_id")
      .whereRaw("frm.related_id = p.id")
      .where("frm.related_type", "api::product.product")
      .where("frm.field", "CoverImage")
      .whereNotNull("f.url");
  });
};

const buildDiscountedVariationExistsPredicate = (knex: any, strapi: any) => {
  const ctx = getProductAvailabilityJoinContext(strapi);
  const discountJoin = getGeneralDiscountVariationJoinInfo(strapi);

  return function discountExists(this: any) {
    this.select(knex.raw("1"))
      .from("product_variations as pv")
      .innerJoin(
        `${ctx.productVariationProductLinkTable} as pv_product_link`,
        `pv_product_link.${ctx.productVariationProductJoinColumn}`,
        "pv.id",
      )
      .whereRaw(`pv_product_link.${ctx.productVariationProductInverseColumn} = p.id`)
      .where("pv.is_published", true)
      .whereRaw("COALESCE(pv.price, 0)::numeric > 0")
      .where(function discountPredicate(this: any) {
        this.whereRaw(
          "COALESCE(pv.discount_price, 0)::numeric > 0 AND COALESCE(pv.discount_price, 0)::numeric < COALESCE(pv.price, 0)::numeric",
        ).orWhereExists(function generalDiscountExists(this: any) {
          this.select(knex.raw("1"))
            .from(`${discountJoin.table} as gd_pv_link`)
            .innerJoin("general_discounts as gd", "gd.id", `gd_pv_link.${discountJoin.joinColumn}`)
            .whereRaw(`gd_pv_link.${discountJoin.inverseColumn} = pv.id`)
            .whereRaw("COALESCE(gd.amount, 0) > 0")
            .whereNull("gd.removed_at");
        });
      });
  };
};

const applyDiscountOnlyFilter = (knex: any, query: any, strapi: any, hasDiscount: unknown) => {
  if (!isEnabledCardParam(hasDiscount)) return;
  query.whereExists(buildDiscountedVariationExistsPredicate(knex, strapi));
};

// Inverse of applyDiscountOnlyFilter. Only takes effect when the caller has already
// resolved `excludeDiscount` against the `hideDiscountedOnDefaultNewestPlp` site setting
// (see resolveExcludeDiscountFlag) -- this function itself trusts whatever it's handed.
//
// `hideDiscountedOnDefaultNewestPlp` is a display preference for the *algorithmic* feed,
// not a hard eligibility rule -- so a manually curated pick that happens to be discounted
// is exempted: an admin's explicit choice to feature it wins over the automatic toggle.
export const applyExcludeDiscountFilter = (
  knex: any,
  query: any,
  strapi: any,
  excludeDiscount: unknown,
  curatedProductIds?: number[],
) => {
  if (!isEnabledCardParam(excludeDiscount)) return;
  const predicate = buildDiscountedVariationExistsPredicate(knex, strapi);

  if (curatedProductIds && curatedProductIds.length > 0) {
    query.where(function excludeDiscountWithCuratedBypass(this: any) {
      this.whereNotExists(predicate).orWhereIn("p.id", curatedProductIds);
    });
    return;
  }

  query.whereNotExists(predicate);
};

const applySearchFilter = (query: any, q: unknown) => {
  const variants = expandSearchTermVariants(q);
  if (variants.length === 0) return;
  query.where(function searchGroup(this: any) {
    for (const variant of variants) {
      const term = `%${variant}%`;
      this.orWhereRaw("LOWER(??) LIKE LOWER(?)", ["p.title", term]).orWhereRaw(
        "LOWER(??) LIKE LOWER(?)",
        ["p.description", term],
      );
    }
  });
};

export const applyAvailabilityAwareOrder = (
  knex: any,
  query: any,
  strapi: any,
  sortKey: string | undefined,
  curatedProductIds?: number[],
) => {
  const ctx = getProductAvailabilityJoinContext(strapi);
  const availabilitySql = buildProductAvailabilityExistsSql(knex, ctx, "p");

  if (curatedProductIds && curatedProductIds.length > 0) {
    // Curated picks always precede the algorithmic fallback, in their exact admin
    // order -- stably partitioned by stock (in-stock curated, then out-of-stock
    // curated) so one unavailable pick can't outrank the rest of the curated list,
    // while the curated block as a whole still always precedes the fallback block.
    // `array_position` needs a real Postgres array; string_to_array(?, ',')::integer[]
    // is this codebase's existing pattern for passing an id list into a raw query
    // (see rankedStockIds in admin-product-list), safer than binding a JS array directly.
    const curatedIdsCsv = curatedProductIds.join(",");
    query.orderByRaw(
      `CASE
         WHEN p.id = ANY(string_to_array(?, ',')::integer[]) AND ${availabilitySql.toQuery()} THEN 0
         WHEN p.id = ANY(string_to_array(?, ',')::integer[]) THEN 1
         WHEN ${availabilitySql.toQuery()} THEN 2
         ELSE 3
       END`,
      [curatedIdsCsv, curatedIdsCsv],
    );
    query.orderByRaw(`array_position(string_to_array(?, ',')::integer[], p.id) ASC NULLS LAST`, [
      curatedIdsCsv,
    ]);
  } else {
    query.orderByRaw(`${availabilitySql.toQuery()} DESC`);
  }

  // "Newest" is driven by admin activity (edits, publish/unpublish, or the manual display-date
  // override), falling back to the first real go-live moment, and finally to raw creation order
  // for legacy/migrated rows that predate both stamps.
  const normalized = sortKey?.trim() || "LastEditedByAdminAt:desc";
  const [rawField, rawDirection] = normalized.split(":");
  const direction = rawDirection === "asc" ? "asc" : "desc";
  if (rawField === "Price" || rawField === "price") {
    const priceSql = buildProductCardDisplayPriceSql(knex, strapi, "p");
    query.orderByRaw(`${priceSql.toQuery()} ${direction.toUpperCase()} NULLS LAST`);
  } else if (rawField === "AverageRating") {
    query.orderByRaw(buildRatingOrderClause(normalized)!);
  } else if (rawField === "LastEditedByAdminAt") {
    query.orderByRaw(
      `COALESCE(p.last_edited_by_admin_at, p.published_at, p.created_at) ${direction.toUpperCase()}`,
    );
  } else {
    const column = PRODUCT_COLUMN_MAP[rawField || "createdAt"] || PRODUCT_COLUMN_MAP.createdAt;
    query.orderBy(`p.${column}`, direction);
  }

  // Tie-break in the same direction as the primary sort, so rows sharing an identical value
  // (bulk imports, migrations) don't reverse within a tied group under a descending sort.
  query.orderBy("p.id", direction);
};

// The client only hints that exclusion may apply; whether it actually does is decided
// here, off the `hideDiscountedOnDefaultNewestPlp` site setting, so the effective on/off
// switch stays admin-side (Strapi content manager / DB) rather than client-controllable.
// The settings lookup only runs when the hint is present, to avoid an extra query on
// every ordinary product-card request.
async function resolveExcludeDiscountFlag(strapi: any, requested: unknown): Promise<boolean> {
  if (!isEnabledCardParam(requested)) return false;
  const settingsEntity = await strapi.db.query("api::settings.settings").findOne();
  const settings = settingsEntity?.attributes || settingsEntity || {};
  return Boolean(settings.hideDiscountedOnDefaultNewestPlp);
}

export async function findOrderedProductIds(strapi: any, params: OrderedProductIdQueryParams = {}) {
  const knex = strapi.db.connection;
  const { limit, page, start, withCount } = parseFindProductCardsPagination(params.pagination);
  const filters = params.filters || {};
  const sortKey = parseQuerySortKey(params.sort);
  const excludeDiscount = await resolveExcludeDiscountFlag(strapi, params.excludeDiscount);
  const curatedProductIds =
    Array.isArray(params.curatedProductIds) && params.curatedProductIds.length > 0
      ? params.curatedProductIds
      : undefined;

  const buildBaseQuery = () => {
    const query = knex("products as p").whereNull("p.removed_at");
    applyProductFilters(knex, query, strapi, filters);
    applySearchFilter(query, params.q);
    applyAvailabilityOnlyFilter(knex, query, strapi, params.availability);
    applyDisplayPriceFilter(knex, query, strapi, params.price);
    applyDiscountOnlyFilter(knex, query, strapi, params.hasDiscount);
    applyExcludeDiscountFilter(knex, query, strapi, excludeDiscount, curatedProductIds);
    applyRequireCoverImageFilter(query, params.requireCoverImage);
    return query;
  };

  const idQuery = buildBaseQuery().select("p.id");
  applyAvailabilityAwareOrder(knex, idQuery, strapi, sortKey, curatedProductIds);
  idQuery.limit(limit).offset(start);

  const countQuery = buildBaseQuery().countDistinct({ total: "p.id" }).first();
  const [rows, totalRow] = await Promise.all([
    idQuery,
    withCount ? countQuery : Promise.resolve(undefined),
  ]);

  const ids = (rows || []).map((row: any) => Number(row.id)).filter(Number.isFinite);
  const rawTotal = totalRow ? Number((totalRow as any).total) : undefined;

  return {
    ids,
    pagination: {
      page,
      pageSize: limit,
      ...(withCount && rawTotal !== undefined
        ? {
            pageCount: Math.ceil(rawTotal / limit) || 1,
            total: rawTotal,
          }
        : {}),
    },
  };
}
