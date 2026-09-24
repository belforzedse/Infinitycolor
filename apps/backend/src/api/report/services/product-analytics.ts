/**
 * Product analytics service.
 *
 * Centralises all product-reporting SQL building, schema (link-table) resolution,
 * and the pure metric helpers used by the report controller. Everything in here is
 * deliberately framework-light so the pure helpers can be unit-tested in isolation
 * and the query builders share a single, audited definition of a "paid sale".
 *
 * Sale definition (confirmed): an order counts when it has net-positive successful
 * settlement. We join orders -> contracts -> contract_transactions, keep only
 * `status = 'Success'`, treat `type = 'Return'` as a negative settlement, group by
 * order and require the net amount to be > 0. This naturally excludes `Paying`
 * (no success transaction) and fully-refunded / cancelled orders (net <= 0).
 *
 * Currency: order_item.PerAmount and product prices are stored in Toman.
 * contract_transactions.amount is stored in IRR; divide by 10 to convert to Toman.
 *
 * See PRODUCT_REPORTING.md for the authoritative metric matrix and known limitations.
 */

import { parsePositiveInt } from "../../../utils/parsePositiveInt";

export const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "Asia/Tehran";
export const DEFAULT_LOW_STOCK_THRESHOLD = parsePositiveInt(
  process.env.REPORT_LOW_STOCK_THRESHOLD,
  5,
);
export const MAX_PAGE_SIZE = 100;

export type Grouping = "day" | "week" | "month";
export type StockStatus = "in" | "low" | "out";

export type TrendPoint = {
  bucket: string;
  gross: number;
  net: number;
  units: number;
  orders: number;
  discounts: number;
  refunds: number;
};

// ---------------------------------------------------------------------------
// Pure helpers (no DB) — unit tested directly.
// ---------------------------------------------------------------------------

export interface Delta {
  current: number;
  previous: number;
  /** Absolute change (current - previous). */
  change: number;
  /**
   * Percentage change. `null` when the previous period is zero (an undefined
   * ratio) so the UI can render "—" instead of a misleading Infinity / 100%.
   */
  changePct: number | null;
}

/**
 * Compute the comparison between a current and previous period value.
 * Zero-period safe: percentage is null when the baseline is 0.
 */
export function periodDelta(current: number, previous: number): Delta {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  const change = cur - prev;
  const changePct = prev === 0 ? null : Number(((change / prev) * 100).toFixed(2));
  return { current: cur, previous: prev, change, changePct };
}

/**
 * Pro-rate an order-level amount (discount or refund) onto a single line by its
 * share of the order's gross. Returns 0 when the order gross is non-positive so
 * we never divide by zero. Used for both discount and refund allocation; refunds
 * are order/contract-level only, so item attribution is necessarily an estimate.
 */
export function allocate(lineGross: number, orderGross: number, orderAmount: number): number {
  const lg = Number(lineGross) || 0;
  const og = Number(orderGross) || 0;
  const amt = Number(orderAmount) || 0;
  if (og <= 0 || lg <= 0 || amt === 0) return 0;
  return (amt * lg) / og;
}

/** Classify a current stock count into in/low/out using the configured threshold. */
export function classifyStock(
  count: number | null | undefined,
  threshold: number = DEFAULT_LOW_STOCK_THRESHOLD,
): StockStatus {
  const c = Number(count) || 0;
  if (c <= 0) return "out";
  if (c <= threshold) return "low";
  return "in";
}

/**
 * Estimate how many days of stock remain at the current sales velocity.
 * `null` means "no sales in window" (infinite cover) — the UI shows ∞ / "—".
 */
export function daysOfCover(
  currentStock: number | null | undefined,
  unitsSold: number,
  windowDays: number,
): number | null {
  const stock = Number(currentStock) || 0;
  const units = Number(unitsSold) || 0;
  if (units <= 0 || windowDays <= 0) return null;
  const perDay = units / windowDays;
  if (perDay <= 0) return null;
  return Number((stock / perDay).toFixed(1));
}

/**
 * First day the store's financial figures are authoritative: ۲۳ شهریور ۱۴۰۵
 * (۲۲ شهریور itself is excluded).
 * Orders and settlements before this were carried over from the previous
 * site, so no money report may include them — not even implicitly through a
 * default window or a previous-period comparison. Every report handler runs
 * its resolved window through {@link clampToFinancialFloor} before querying.
 *
 * The boundary is Tehran midnight written with the same fixed offset the
 * controller's `tehranBoundary` uses, so both sides agree to the millisecond.
 */
export const FINANCIAL_DATA_FLOOR_YMD = "2026-09-14";
export const FINANCIAL_DATA_FLOOR = new Date(`${FINANCIAL_DATA_FLOOR_YMD}T00:00:00.000+03:30`);

/**
 * Clamp a resolved [start, end] window so nothing before the floor is queried.
 * Must be the last step after any swap-normalization: a window wholly before
 * the floor becomes the empty window [floor, floor − 1ms], which `BETWEEN`
 * matches nothing against and `fillBucketSeries` renders as no buckets.
 */
export function clampToFinancialFloor(
  window: { start: Date; end: Date },
  floor: Date = FINANCIAL_DATA_FLOOR,
): { start: Date; end: Date } {
  const floorMs = floor.getTime();
  const start = window.start.getTime() < floorMs ? new Date(floorMs) : window.start;
  const end = window.end.getTime() < floorMs ? new Date(floorMs - 1) : window.end;
  return { start, end };
}

/** Inclusive day-count of a [start, end] window (never less than 1). */
export function windowDays(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}

/**
 * Given a [start, end] window, return the immediately-preceding equal-length
 * window so KPI comparisons line up like-for-like.
 */
export function previousPeriod(start: Date, end: Date): { start: Date; end: Date } {
  const span = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime());
  const prevStart = new Date(start.getTime() - span);
  return { start: prevStart, end: prevEnd };
}

/** Pick a sensible bucket grouping for a window when the client asks for "auto". */
export function autoGrouping(start: Date, end: Date): Grouping {
  const days = windowDays(start, end);
  if (days <= 45) return "day";
  if (days <= 180) return "week";
  return "month";
}

export function normalizeGrouping(value: unknown, start: Date, end: Date): Grouping {
  const v = typeof value === "string" ? value.toLowerCase() : "";
  if (v === "day" || v === "week" || v === "month") return v;
  return autoGrouping(start, end);
}

/** Allow-list of sortable columns for the performance table (prevents SQL injection via sort). */
export const PERFORMANCE_SORT_COLUMNS: Record<string, string> = {
  units: "units",
  gross: "gross",
  net: "net",
  discounts: "discounts",
  refunds: "refunds",
  orders: "orders_count",
  avgPrice: "avg_price",
  stock: "current_stock",
  productStock: "product_total_stock",
  title: "product_title",
};

export function normalizeSort(
  sort: unknown,
): { column: string; direction: "asc" | "desc" } {
  let key = "gross";
  let dir: "asc" | "desc" = "desc";
  if (typeof sort === "string" && sort.length > 0) {
    const [rawKey, rawDir] = sort.split(":");
    if (rawKey && PERFORMANCE_SORT_COLUMNS[rawKey]) key = rawKey;
    if (rawDir && rawDir.toLowerCase() === "asc") dir = "asc";
    if (rawDir && rawDir.toLowerCase() === "desc") dir = "desc";
  }
  return { column: PERFORMANCE_SORT_COLUMNS[key], direction: dir };
}

export function clampPageSize(value: unknown, fallback = 25): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_PAGE_SIZE);
}

export function clampPage(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

/** IRR (contract transaction amount) -> Toman. */
export function irrToToman(irr: number | null | undefined): number {
  return (Number(irr) || 0) / 10;
}

/**
 * Persian display labels for the `orders.payment_gateway` enum. Legacy / missing
 * values (null, "", "Unknown") fall under "نامشخص"; any unknown value falls back to
 * its raw string so a newly-added gateway still renders something meaningful.
 */
export const GATEWAY_LABELS_FA: Record<string, string> = {
  Unknown: "نامشخص",
  Wallet: "کیف پول",
  Mellat: "ملت",
  SnappPay: "اسنپ‌پی",
  SamanKish: "سامان",
  ZarinPal: "زرین‌پال",
  // Non-gateway channels the WooCommerce importer distinguishes (see
  // scripts/woocommerce-importer/migration-v2/lib/transforms.js).
  Manual: "ثبت دستی",
  OffGateway: "پرداخت خارج از درگاه",
  CardToCard: "کارت به کارت",
  Other: "سایر",
};

export function gatewayLabelFa(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return GATEWAY_LABELS_FA.Unknown;
  return GATEWAY_LABELS_FA[v] ?? v;
}

/**
 * Annotate each row with its `sharePct` of the summed `key` value (rounded to 2dp).
 * `null` when the total is 0 so the UI shows "—" instead of a misleading 0%/NaN.
 */
export function withShares<T extends Record<string, any>>(
  rows: T[],
  key: keyof T,
): Array<T & { sharePct: number | null }> {
  const total = rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
  return rows.map((r) => ({
    ...r,
    sharePct:
      total > 0 ? Number((((Number(r[key]) || 0) / total) * 100).toFixed(2)) : null,
  }));
}

/** Shape a raw performance SQL row into the API payload (pure; unit-tested). */
export interface RawPerformanceRow {
  product_variation_id: number | null;
  product_id: number | null;
  product_title: string | null;
  product_sku: string | null;
  product_type: string | null;
  category_title: string | null;
  units: string | number | null;
  gross: string | number | null;
  discounts: string | number | null;
  refunds_irr: string | number | null;
  orders_count: string | number | null;
  current_stock: string | number | null;
  reserved_stock: string | number | null;
  variant_color: string | null;
  variant_color_code: string | null;
  variant_size: string | null;
  variant_model: string | null;
  variant_other: string | null;
  /** Product-level stock, summed over EVERY variation — see {@link productStockTotalsCte}. */
  product_total_stock: string | number | null;
  product_variation_count: string | number | null;
}

export interface ProductPerformanceRow {
  productVariationId: number | null;
  productId: number | null;
  productTitle: string;
  productSKU: string;
  productType: string | null;
  category: string | null;
  units: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  ordersCount: number;
  avgPrice: number;
  currentStock: number | null;
  reservedStock: number | null;
  stockStatus: StockStatus | "unknown";
  imageUrl?: string | null;
  variantColor: string | null;
  variantColorCode: string | null;
  variantSize: string | null;
  variantModel: string | null;
  /** Custom (non-projected) attributes, pre-joined as «نام: مقدار، نام: مقدار». */
  variantOther: string | null;
  /** `variantColor / variantSize / variantModel`, blanks dropped; null when all are empty. */
  variantLabel: string | null;
  /**
   * Stock across ALL of this product's variations. `currentStock` above is only
   * THIS variation's — the report is variant-grained. Null when the row has no
   * surviving variation (and therefore no product) to total.
   */
  productTotalStock: number | null;
  productVariationCount: number | null;
}

/**
 * Human-readable variant identity, e.g. «مشکی / L».
 *
 * Lives here rather than in the admin because the xlsx export builds the same
 * string server-side; computing it in the UI would mean writing it twice in two
 * languages and letting the two drift.
 */
export function variantLabel(parts: {
  color?: string | null;
  size?: string | null;
  model?: string | null;
}): string | null {
  const joined = [parts.color, parts.size, parts.model]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" / ");
  return joined || null;
}

/** Null-preserving text read — an absent relation must render "—", never "". */
function variantText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function serializeProductRow(
  row: RawPerformanceRow,
  threshold: number = DEFAULT_LOW_STOCK_THRESHOLD,
): ProductPerformanceRow {
  const units = Number(row.units) || 0;
  const gross = Number(row.gross) || 0;
  const discounts = Number(row.discounts) || 0;
  const refunds = irrToToman(Number(row.refunds_irr) || 0);
  const net = Math.max(0, Math.round(gross - discounts - refunds));
  const hasStock = row.current_stock !== null && row.current_stock !== undefined;
  const currentStock = hasStock ? Number(row.current_stock) || 0 : null;
  const { variantAttrs: _unused, ...variant } = serializeVariantIdentity(row);
  // A row whose variation was deleted has no product, so it has no product total.
  // 0 would read as "out of stock"; null renders "—".
  const hasTotal = row.product_total_stock !== null && row.product_total_stock !== undefined;
  return {
    productVariationId: row.product_variation_id ?? null,
    productId: row.product_id ?? null,
    productTitle: row.product_title || "—",
    productSKU: row.product_sku || "—",
    productType: row.product_type ?? null,
    category: row.category_title ?? null,
    units,
    gross: Math.round(gross),
    discounts: Math.round(discounts),
    refunds: Math.round(refunds),
    net,
    ordersCount: Number(row.orders_count) || 0,
    avgPrice: units > 0 ? Math.round(gross / units) : 0,
    currentStock,
    reservedStock: hasStock ? Number(row.reserved_stock) || 0 : null,
    stockStatus: currentStock === null ? "unknown" : classifyStock(currentStock, threshold),
    ...variant,
    productTotalStock: hasTotal ? Number(row.product_total_stock) || 0 : null,
    productVariationCount: hasTotal ? Number(row.product_variation_count) || 0 : null,
  };
}

// ---------------------------------------------------------------------------
// Schema resolution — resolve Strapi link tables ONCE per process.
//
// Strapi 4 link-table and FK-column names are deterministic but the column for a
// relation is named after the *target entity singular* (e.g. `performed_by` ->
// `user_id`), so we detect names from information_schema rather than hard-coding
// them. Detection runs once and is memoised; this replaces the previous
// per-request schema probing in the product-sales endpoint.
// ---------------------------------------------------------------------------

type Knex = any;

interface LinkTable {
  table: string;
  cols: Set<string>;
}

/**
 * The generic variation-attribute chain, hard-coded because it is a two-hop join
 * that {@link resolveRelation} cannot express. Presence is still probed at runtime
 * (see `hasVariationAttributes`) so a drifted schema degrades instead of 500ing.
 * Names verified against `scripts/repair-woocommerce-variation-attributes.js`.
 */
const VARIATION_TERM_LINK_TABLE = "product_variations_selected_attribute_terms_links";
const TERM_ATTRIBUTE_LINK_TABLE = "product_attribute_terms_product_attribute_links";

let cachedLinks: Promise<LinkTable[]> | null = null;

/** All Strapi `*_links` join tables with their columns, scanned once per process. */
async function getLinkTables(knex: Knex): Promise<LinkTable[]> {
  if (cachedLinks) return cachedLinks;
  cachedLinks = (async () => {
    const res = await knex.raw(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE '%_links'`,
    );
    const tables = (res.rows || res[0] || []).map((r: any) => String(r.table_name));
    const out: LinkTable[] = [];
    for (const table of tables) {
      out.push({ table, cols: await columns(knex, table) });
    }
    return out;
  })();
  return cachedLinks;
}

/**
 * How the `product_categories.parent` self-relation is physically stored.
 *
 * `table` is either a Strapi link table (`childCol`/`parentCol` are two columns
 * on it) or `product_categories` itself when the install carries a direct FK —
 * in that case `childCol` is `"id"`, so `SELECT parentCol FROM table WHERE
 * childCol = <id>` reads the same either way and callers need no special case.
 */
export interface CategoryParentLink {
  table: string;
  /** Column holding the CHILD id — the row that owns the `parent` attribute. */
  childCol: string;
  /** Column holding the PARENT id. */
  parentCol: string;
}

export interface ResolvedJoins {
  /** order_items oi -> orders o */
  oiToOrder: string;
  /** order_items oi -> product_variations pv ; plus the id expression to select. */
  oiToVariation: { join: string; idExpr: string };
  /** orders o -> contracts c */
  orderToContract: string;
  /** contracts c -> contract_transactions ct */
  contractToTx: string;
  /** product_variations pv -> products p */
  variationToProduct: string;
  /** product_variations pv -> product_stocks ps (LEFT) */
  variationToStock: string;
  /**
   * product_variations pv -> product_variation_colors pvc (LEFT), plus the title
   * and swatch expressions.
   *
   * These three attribute relations are unidirectional oneToOne owned by the
   * variation, so Strapi stores them in a link table ONLY — `product_variations`
   * carries no FK column and `resolveRelation`'s direct-FK fallback cannot fire.
   * A missing link table therefore degrades to `{ join: "", titleExpr: "NULL::text" }`
   * (the {@link ResolvedJoins.productToCategory} pattern): the report loses its
   * colour dimension rather than failing.
   *
   * These are the LEGACY PROJECTION of the generic attribute model — the same
   * values also reach a variation through `selected_attribute_terms` (see
   * {@link variationAttributesCte}). Neither axis is fully populated, so display
   * values coalesce this one over the generic one.
   */
  variationToColor: { join: string; titleExpr: string; codeExpr: string };
  /** product_variations pv -> product_variation_sizes pvs (LEFT) */
  variationToSize: { join: string; titleExpr: string };
  /** product_variations pv -> product_variation_models pvm (LEFT) */
  variationToModel: { join: string; titleExpr: string };
  /**
   * Whether the generic variation-attribute link tables are present, which is the
   * precondition for {@link variationAttributesCte} emitting anything.
   */
  hasVariationAttributes: boolean;
  /**
   * products p -> the product's MAIN product_categories pc (LEFT), plus the title
   * expression. This is the product's *label* category — the single name shown on a
   * product row — and is NOT the definition of category membership. A product also
   * belongs to every category in `product_other_categories`, so anything that
   * ASSIGNS revenue to a category must use {@link ResolvedJoins.categoryMembershipTables}
   * (via {@link categoryMembershipCte}) instead of this join. Using this join to
   * decide membership silently drops every "other category" assignment.
   */
  productToCategory: { join: string; titleExpr: string };
  /**
   * Every link table that expresses "this product belongs to this category" —
   * `products_product_main_category_links` AND
   * `products_product_other_categories_links`. Their UNION is the canonical
   * membership set, and is exactly what the storefront PLP filters on
   * (`product_main_category.Slug IN (...) OR product_other_categories.Slug IN (...)`,
   * see apps/frontend/src/services/product/plp.ts). Empty when none resolve.
   */
  categoryMembershipTables: string[];
  /**
   * The product_categories `parent` self-relation, for reports that roll sales up
   * the category tree. Null when the relation can't be resolved — callers must
   * degrade to a flat, non-hierarchical result rather than failing.
   */
  categoryParentLink: CategoryParentLink | null;
  /** orders o -> shippings s (LEFT). Empty string when the relation can't be resolved. */
  orderToShipping: string;
  /** orders o -> users-permissions users u (LEFT). Empty string when unresolved. */
  orderToUser: string;
  /** orders o -> local_user_infos ui, keyed off u.id (LEFT). Empty string when unresolved. */
  userToInfo: string;
  /** orders o -> local_user_addresses a via delivery_address (LEFT). Empty string when unresolved. */
  orderToAddress: string;
  /** local_user_addresses a -> shipping_cities sc (LEFT). Empty string when unresolved. */
  addressToCity: string;
  /** shipping_cities sc -> shipping_provinces sp (LEFT). Empty string when unresolved. */
  cityToProvince: string;
  /**
   * Whether `contract_transactions.settlement_gateway` exists. The WooCommerce
   * importer tags each settlement leg with the channel that carried the money
   * (a split order has a Wallet leg and a gateway leg); when the column is
   * missing every leg is attributed to `orders.payment_gateway`.
   */
  txSettlementGateway: boolean;
}

let cachedJoins: Promise<ResolvedJoins> | null = null;

async function columns(knex: Knex, table: string): Promise<Set<string>> {
  const res = await knex.raw(
    `SELECT column_name FROM information_schema.columns WHERE table_name = ?`,
    [table],
  );
  return new Set((res.rows || res[0] || []).map((r: any) => String(r.column_name)));
}

async function hasColumn(knex: Knex, table: string, column: string): Promise<boolean> {
  return (await columns(knex, table)).has(column);
}

function pickColumn(cols: Set<string>, ...candidates: string[]): string | undefined {
  for (const c of candidates) if (cols.has(c)) return c;
  // suffix match fallback (e.g. some installs prefix link columns)
  for (const c of candidates) {
    for (const col of cols) if (col.endsWith(c)) return col;
  }
  return undefined;
}

/**
 * Resolve a relation that may be stored either as a Strapi link table or as a
 * direct FK column on the "owning" table. Returns a ready-to-embed JOIN clause
 * assuming the owner alias is already in scope.
 */
async function resolveRelation(
  knex: Knex,
  opts: {
    ownerIdCol: string; // column in link table pointing at owner (e.g. order_item_id)
    targetIdCol: string; // column in link table pointing at target (e.g. order_id)
    ownerAlias: string;
    ownerKey?: string; // owner PK expression (default `${ownerAlias}.id`)
    targetTable: string;
    targetAlias: string;
    directFkTable: string; // table to check for a direct FK
    directFkCandidates: string[]; // direct FK column candidates on directFkTable
    directFkOn: "owner" | "target"; // which side holds the direct FK
    join?: "JOIN" | "LEFT JOIN";
    /**
     * When several link tables carry the same FK column pair (e.g. main vs. other
     * categories both have product_id + product_category_id), prefer the table
     * whose name contains this substring.
     */
    preferName?: string;
  },
): Promise<string> {
  const joinType = opts.join || "JOIN";
  const ownerKey = opts.ownerKey || `${opts.ownerAlias}.id`;

  // Prefer a link table that carries BOTH required FK columns (order-agnostic).
  const links = await getLinkTables(knex);
  const candidates = links.filter(
    ({ cols }) => cols.has(opts.ownerIdCol) && cols.has(opts.targetIdCol),
  );
  const chosen =
    (opts.preferName && candidates.find((c) => c.table.includes(opts.preferName!))) ||
    candidates[0];
  if (chosen) {
    const lAlias = `l_${opts.targetAlias}`;
    return `${joinType} ${chosen.table} ${lAlias} ON ${lAlias}.${opts.ownerIdCol} = ${ownerKey} ${joinType} ${opts.targetTable} ${opts.targetAlias} ON ${opts.targetAlias}.id = ${lAlias}.${opts.targetIdCol}`;
  }

  // Fallback: direct FK column on the main table.
  const fkCols = await columns(knex, opts.directFkTable);
  const fk = pickColumn(fkCols, ...opts.directFkCandidates);
  if (fk) {
    if (opts.directFkOn === "owner") {
      return `${joinType} ${opts.targetTable} ${opts.targetAlias} ON ${opts.targetAlias}.id = ${opts.ownerAlias}.${fk}`;
    }
    return `${joinType} ${opts.targetTable} ${opts.targetAlias} ON ${opts.targetAlias}.${fk} = ${ownerKey}`;
  }
  throw new Error(`RELATION_NOT_FOUND: could not resolve relation for ${opts.targetTable}`);
}

/**
 * Resolve every link table that expresses product -> category membership.
 *
 * Strapi stores `product_main_category` and `product_other_categories` in two
 * separate link tables that carry the SAME column pair (product_id,
 * product_category_id). `resolveRelation` can only ever pick ONE of them, which is
 * why every category report used to see main-category assignments only — a product
 * filed under a category through `product_other_categories` contributed nothing to
 * that category's revenue, and nothing on screen said so.
 *
 * Both tables are returned so callers can UNION them into the canonical membership
 * set. Filtered on a `categor` name fragment so an unrelated link table that
 * happens to share the column pair can't leak in; `product_categories_parent_links`
 * is excluded automatically because it has no `product_id` column.
 *
 * Never throws: an unresolvable schema costs the caller its category dimension,
 * not the whole report.
 */
async function resolveCategoryMembershipTables(knex: Knex): Promise<string[]> {
  try {
    const links = await getLinkTables(knex);
    return links
      .filter(
        ({ table, cols }) =>
          table.includes("categor") &&
          cols.has("product_id") &&
          cols.has("product_category_id"),
      )
      .map(({ table }) => table)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve `product_categories.parent`.
 *
 * `resolveRelation` can't express this one: it filters link tables on two
 * DISTINCT FK column names, and a self-relation names both sides after the same
 * table (`product_category_id` for the child, `inv_product_category_id` for the
 * parent). Hence this dedicated lookup, which keeps the same defensive posture —
 * never throws, returns null when the shape isn't there, so a drifted database
 * costs the caller its hierarchy rather than the whole report.
 */
async function resolveCategoryParentLink(knex: Knex): Promise<CategoryParentLink | null> {
  try {
    const links = await getLinkTables(knex);
    const candidates = links.filter(
      ({ table, cols }) =>
        table.includes("product_categor") &&
        cols.has("product_category_id") &&
        cols.has("inv_product_category_id"),
    );
    const chosen = candidates.find((c) => c.table.includes("parent")) || candidates[0];
    if (chosen) {
      return {
        table: chosen.table,
        childCol: "product_category_id",
        parentCol: "inv_product_category_id",
      };
    }

    // Fallback: some installs carry the parent as a plain FK on the row itself.
    const cols = await columns(knex, "product_categories");
    const fk = pickColumn(cols, "parent_id", "product_category_parent_id");
    if (fk) return { table: "product_categories", childCol: "id", parentCol: fk };
  } catch {
    return null;
  }
  return null;
}

export async function resolveJoins(knex: Knex): Promise<ResolvedJoins> {
  if (cachedJoins) return cachedJoins;
  cachedJoins = (async () => {
    const oiToOrder = await resolveRelation(knex, {
      ownerIdCol: "order_item_id",
      targetIdCol: "order_id",
      ownerAlias: "oi",
      targetTable: "orders",
      targetAlias: "o",
      directFkTable: "order_items",
      directFkCandidates: ["order_id", "order"],
      directFkOn: "owner",
    });

    // order_items -> product_variations (optional; deleted variations leave it null)
    let oiToVariation: { join: string; idExpr: string };
    try {
      const join = await resolveRelation(knex, {
        ownerIdCol: "order_item_id",
        targetIdCol: "product_variation_id",
        ownerAlias: "oi",
        targetTable: "product_variations",
        targetAlias: "pv",
        directFkTable: "order_items",
        directFkCandidates: ["product_variation_id"],
        directFkOn: "owner",
        join: "LEFT JOIN",
      });
      oiToVariation = { join, idExpr: "pv.id" };
    } catch {
      if (await hasColumn(knex, "order_items", "product_variation_id")) {
        oiToVariation = { join: "", idExpr: "oi.product_variation_id" };
      } else {
        oiToVariation = { join: "", idExpr: "NULL::int" };
      }
    }

    const orderToContract = await resolveRelation(knex, {
      ownerIdCol: "order_id",
      targetIdCol: "contract_id",
      ownerAlias: "o",
      targetTable: "contracts",
      targetAlias: "c",
      directFkTable: "contracts",
      directFkCandidates: ["order_id", "order"],
      directFkOn: "target",
    });

    const contractToTx = await resolveRelation(knex, {
      ownerIdCol: "contract_id",
      targetIdCol: "contract_transaction_id",
      ownerAlias: "c",
      targetTable: "contract_transactions",
      targetAlias: "ct",
      directFkTable: "contract_transactions",
      directFkCandidates: ["contract_id", "contract"],
      directFkOn: "target",
    });

    const variationToProduct = await resolveRelation(knex, {
      ownerIdCol: "product_variation_id",
      targetIdCol: "product_id",
      ownerAlias: "pv",
      targetTable: "products",
      targetAlias: "p",
      directFkTable: "product_variations",
      directFkCandidates: ["product_id", "product"],
      directFkOn: "owner",
    });

    let variationToStock = "";
    try {
      variationToStock = await resolveRelation(knex, {
        ownerIdCol: "product_variation_id",
        targetIdCol: "product_stock_id",
        ownerAlias: "pv",
        targetTable: "product_stocks",
        targetAlias: "ps",
        directFkTable: "product_stocks",
        directFkCandidates: ["product_variation_id"],
        directFkOn: "target",
        join: "LEFT JOIN",
      });
    } catch {
      variationToStock = "";
    }

    // Variation attribute projections. The FK candidate is spelled in full on
    // purpose: `pickColumn` falls back to `endsWith`, so a short form like
    // "color_id" could latch onto an unrelated column.
    let variationToColor = { join: "", titleExpr: "NULL::text", codeExpr: "NULL::text" };
    try {
      const join = await resolveRelation(knex, {
        ownerIdCol: "product_variation_id",
        targetIdCol: "product_variation_color_id",
        ownerAlias: "pv",
        targetTable: "product_variation_colors",
        targetAlias: "pvc",
        directFkTable: "product_variations",
        directFkCandidates: ["product_variation_color_id"],
        directFkOn: "owner",
        join: "LEFT JOIN",
      });
      variationToColor = { join, titleExpr: "pvc.title", codeExpr: "pvc.color_code" };
    } catch {
      variationToColor = { join: "", titleExpr: "NULL::text", codeExpr: "NULL::text" };
    }

    let variationToSize = { join: "", titleExpr: "NULL::text" };
    try {
      const join = await resolveRelation(knex, {
        ownerIdCol: "product_variation_id",
        targetIdCol: "product_variation_size_id",
        ownerAlias: "pv",
        targetTable: "product_variation_sizes",
        targetAlias: "pvs",
        directFkTable: "product_variations",
        directFkCandidates: ["product_variation_size_id"],
        directFkOn: "owner",
        join: "LEFT JOIN",
      });
      variationToSize = { join, titleExpr: "pvs.title" };
    } catch {
      variationToSize = { join: "", titleExpr: "NULL::text" };
    }

    let variationToModel = { join: "", titleExpr: "NULL::text" };
    try {
      const join = await resolveRelation(knex, {
        ownerIdCol: "product_variation_id",
        targetIdCol: "product_variation_model_id",
        ownerAlias: "pv",
        targetTable: "product_variation_models",
        targetAlias: "pvm",
        directFkTable: "product_variations",
        directFkCandidates: ["product_variation_model_id"],
        directFkOn: "owner",
        join: "LEFT JOIN",
      });
      variationToModel = { join, titleExpr: "pvm.title" };
    } catch {
      variationToModel = { join: "", titleExpr: "NULL::text" };
    }

    // The generic attribute join is two hops plus a GROUP BY, which does not fit
    // resolveRelation's single owner/target column pair. Probe the same cached
    // link-table listing instead, so a drifted schema still degrades to "".
    const linkTables = await getLinkTables(knex);
    const hasVariationAttributes = [
      VARIATION_TERM_LINK_TABLE,
      TERM_ATTRIBUTE_LINK_TABLE,
    ].every((name) => linkTables.some((link) => link.table === name));

    let productToCategory = { join: "", titleExpr: "NULL::text" };
    try {
      const join = await resolveRelation(knex, {
        ownerIdCol: "product_id",
        targetIdCol: "product_category_id",
        ownerAlias: "p",
        targetTable: "product_categories",
        targetAlias: "pc",
        directFkTable: "products",
        directFkCandidates: ["product_main_category_id"],
        directFkOn: "owner",
        join: "LEFT JOIN",
        preferName: "main",
      });
      productToCategory = { join, titleExpr: "pc.title" };
    } catch {
      productToCategory = { join: "", titleExpr: "NULL::text" };
    }

    const categoryParentLink = await resolveCategoryParentLink(knex);
    const categoryMembershipTables = await resolveCategoryMembershipTables(knex);

    // orders -> shippings (owning FK is on the order side; deleted/legacy = null)
    let orderToShipping = "";
    try {
      orderToShipping = await resolveRelation(knex, {
        ownerIdCol: "order_id",
        targetIdCol: "shipping_id",
        ownerAlias: "o",
        targetTable: "shippings",
        targetAlias: "s",
        directFkTable: "orders",
        directFkCandidates: ["shipping_id", "shipping"],
        directFkOn: "owner",
        join: "LEFT JOIN",
      });
    } catch {
      orderToShipping = "";
    }

    // orders -> users-permissions users (owning FK is on the order side)
    let orderToUser = "";
    try {
      orderToUser = await resolveRelation(knex, {
        ownerIdCol: "order_id",
        targetIdCol: "user_id",
        ownerAlias: "o",
        targetTable: "users",
        targetAlias: "u",
        directFkTable: "orders",
        directFkCandidates: ["user_id", "user"],
        directFkOn: "owner",
        join: "LEFT JOIN",
      });
    } catch {
      orderToUser = "";
    }

    // users -> local_user_infos (display name; owning FK is on the info side)
    let userToInfo = "";
    try {
      userToInfo = await resolveRelation(knex, {
        ownerIdCol: "user_id",
        targetIdCol: "local_user_info_id",
        ownerAlias: "u",
        targetTable: "local_user_infos",
        targetAlias: "ui",
        directFkTable: "local_user_infos",
        directFkCandidates: ["user_id", "user"],
        directFkOn: "target",
        join: "LEFT JOIN",
      });
    } catch {
      userToInfo = "";
    }

    // orders -> local_user_addresses via delivery_address (owning FK is on the order side).
    // Verified against a real Postgres instance: link table `orders_delivery_address_links`
    // uses columns (order_id, local_user_address_id) — NOT the generic "address_id" this
    // codebase's other relations use, so both id columns are spelled out explicitly.
    let orderToAddress = "";
    try {
      orderToAddress = await resolveRelation(knex, {
        ownerIdCol: "order_id",
        targetIdCol: "local_user_address_id",
        ownerAlias: "o",
        targetTable: "local_user_addresses",
        targetAlias: "a",
        directFkTable: "orders",
        directFkCandidates: ["delivery_address_id", "delivery_address"],
        directFkOn: "owner",
        join: "LEFT JOIN",
      });
    } catch {
      orderToAddress = "";
    }

    // local_user_addresses -> shipping_cities. Verified: link table
    // `local_user_addresses_shipping_city_links` uses (local_user_address_id, shipping_city_id).
    let addressToCity = "";
    try {
      addressToCity = await resolveRelation(knex, {
        ownerIdCol: "local_user_address_id",
        targetIdCol: "shipping_city_id",
        ownerAlias: "a",
        targetTable: "shipping_cities",
        targetAlias: "sc",
        directFkTable: "local_user_addresses",
        directFkCandidates: ["shipping_city_id", "shipping_city"],
        directFkOn: "owner",
        join: "LEFT JOIN",
      });
    } catch {
      addressToCity = "";
    }

    // shipping_cities -> shipping_provinces. Verified: link table
    // `shipping_cities_shipping_province_links` uses (shipping_city_id, shipping_province_id).
    let cityToProvince = "";
    try {
      cityToProvince = await resolveRelation(knex, {
        ownerIdCol: "shipping_city_id",
        targetIdCol: "shipping_province_id",
        ownerAlias: "sc",
        targetTable: "shipping_provinces",
        targetAlias: "sp",
        directFkTable: "shipping_cities",
        directFkCandidates: ["shipping_province_id", "shipping_province"],
        directFkOn: "owner",
        join: "LEFT JOIN",
      });
    } catch {
      cityToProvince = "";
    }

    let txSettlementGateway = false;
    try {
      txSettlementGateway = await hasColumn(knex, "contract_transactions", "settlement_gateway");
    } catch {
      txSettlementGateway = false;
    }

    return {
      oiToOrder,
      oiToVariation,
      orderToContract,
      contractToTx,
      variationToProduct,
      variationToStock,
      variationToColor,
      variationToSize,
      variationToModel,
      hasVariationAttributes,
      productToCategory,
      categoryMembershipTables,
      categoryParentLink,
      orderToShipping,
      orderToUser,
      userToInfo,
      orderToAddress,
      addressToCity,
      cityToProvince,
      txSettlementGateway,
    };
  })();
  return cachedJoins;
}

/** Test/maintenance helper to clear the memoised schema resolution. */
export function __resetJoinCache() {
  cachedJoins = null;
  cachedLinks = null;
}

// ---------------------------------------------------------------------------
// SQL fragments shared by every product query.
// ---------------------------------------------------------------------------

/**
 * The canonical "paid orders" CTE. Produces one row per qualifying order with:
 *   - order_date:  the order timestamp (UTC) for trend bucketing
 *   - order_discount: order-level applied discount (Toman)
 *   - settled_irr: net successful settlement in IRR (Returns subtracted)
 *   - refund_irr:  sum of successful Return transactions in IRR (>= 0)
 * Bindings: [start, end] on order date.
 */
/**
 * Order statuses that count as a sale: the order is in fulfilment — accepted and
 * being worked (`Started`, «در حال انجام»), prepared (`Done`) or shipped
 * (`Shipment`, the terminal step AFTER `Done` in this lifecycle, so leaving it
 * out would make revenue disappear the moment an order ships).
 *
 * `Started` IS a sale (decision D15, superseding D14). The gateway-success path
 * advances an order `Paying -> Started` on settlement and stops there (`Done` is
 * an admin-only transition), so under D14 a paid order contributed nothing to
 * «فروش» until an operator touched it: the sales page read zero on days the shop
 * had genuinely taken money, and every KPI lagged the fulfilment desk rather than
 * the till. The store asked for the takings, so the gate follows the money into
 * fulfilment and stops short only of the statuses where no sale stands —
 * `Paying` (never settled), `Cancelled` and `Returned` (unwound).
 *
 * The D14 failure mode is not forgotten, it is relocated: «فروش» now answers
 * "what did we take", and the day's unaccepted orders are visible as their own
 * «شروع‌شده» row in the status breakdown, which is status-independent and always
 * has been. An operator asking "what have we actually completed" reads that row,
 * not the KPI card.
 *
 * Changing this set is a REPORTING DEFINITION CHANGE, not a bug fix: every money
 * KPI, the liquidity and gateway pages and the behaviour dashboard's eligible
 * -order count read it, and a change here silently restates history. Bump the
 * `sales.eligibleOrders` definitionVersion in analytics/metrics/catalog.ts with it.
 *
 * BOTH paid-orders definitions gate on this set. They used to disagree:
 * `completed` required a status while `settled` required only a successful
 * gateway transaction, so a Cancelled order that had been paid before it was
 * cancelled was reported as revenue. `settled` means "eligible status AND
 * gateway-settled" — a strict subset of `completed` — so switching definitions can
 * only ever narrow the set, never swap it for a different one.
 *
 * `ELIGIBLE_ORDER_STATUS` is the canonical completed status; fixtures create
 * orders with it. The gate itself is `ELIGIBLE_ORDER_STATUSES`.
 */
export const ELIGIBLE_ORDER_STATUS = "Done";
export const ELIGIBLE_ORDER_STATUSES = ["Started", "Shipment", "Done"] as const;
export const ELIGIBLE_STATUS_SQL = ELIGIBLE_ORDER_STATUSES.map((status) => `'${status}'`).join(", ");

/**
 * Order statuses that mean THE CUSTOMER PAID — a different question from "is this
 * a sale", even when the two sets happen to list the same statuses.
 *
 * The behaviour dashboard's «سفارش پرداخت‌شده» answers "how many visits turned into
 * a payment": conversion happens at the gateway, not at the fulfilment desk, so a
 * paid order that no operator has processed yet still converted. It also carries no
 * settlement gate — status alone decides membership.
 *
 * Kept as its own named constant even though D15 makes it equal to
 * {@link ELIGIBLE_ORDER_STATUSES} by value: the two answer different questions and
 * have diverged before (D14) and may again. Do not collapse them into one.
 *
 * NEVER use this for money. Every revenue figure gates on ELIGIBLE_ORDER_STATUSES,
 * a subset of this set (currently equal, additionally narrowed by the settlement
 * gate) — the two answer "sold" and "paid", and the page that shows each one says
 * which it means.
 */
export const PAID_ORDER_STATUSES = ["Started", "Shipment", "Done"] as const;
export const PAID_STATUS_SQL = PAID_ORDER_STATUSES.map((status) => `'${status}'`).join(", ");

export type PaidOrdersDefinition = "settled" | "completed";

/**
 * Which date a report keys on.
 *
 * - `order`: the order's creation date (`orders.date`). Order and product pages
 *   use it, and it is what WooCommerce's own order list shows.
 * - `settlement`: the date the money arrived (`contract_transactions.date` of the
 *   first successful non-return leg; the importer copies WooCommerce
 *   `date_paid_gmt` onto it). Money pages — liquidity, the gateway breakdown —
 *   use it, and it is what the Payzito ledger shows. An order created at 23:50
 *   and paid at 00:10 sits in different days on the two clocks; that is
 *   expected and both are right for their page.
 */
export type ReportClock = "order" | "settlement";

const SETTLED_AT_EXPR =
  "MIN(ct.date) FILTER (WHERE ct.status = 'Success' AND ct.type <> 'Return')";

/**
 * The canonical "paid orders" CTE. Produces one row per qualifying order with:
 *   - order_date:   the clock timestamp (UTC) for windowing and trend bucketing —
 *                   the creation date on the `order` clock, the settlement date
 *                   (falling back to creation) on the `settlement` clock
 *   - settled_at:   first successful non-return settlement (NULL when none)
 *   - order_discount: order-level applied discount (Toman)
 *   - settled_irr:  net successful settlement in IRR (Returns subtracted)
 *   - refund_irr:   sum of successful Return transactions in IRR (>= 0)
 * Bindings: [start, end] on the clock date.
 */
export function paidOrdersCte(
  joins: ResolvedJoins,
  definition: PaidOrdersDefinition = "settled",
  clock: ReportClock = "order",
): string {
  const statusGate = `o.status IN (${ELIGIBLE_STATUS_SQL})`;
  if (definition === "completed") {
    // Same column contract, but membership is "the shop is fulfilling the
    // order" rather than "the gateway settled it". Settlement columns are still
    // summed where transactions exist, so revenue stays real where it is
    // known and reads 0 for orders that never had a gateway leg.
    const window = clock === "settlement"
      ? `HAVING COALESCE(${SETTLED_AT_EXPR}, o.date) BETWEEN ? AND ?`
      : "";
    return `
      paid_orders AS (
        SELECT
          o.id AS order_id,
          ${clock === "settlement" ? `COALESCE(${SETTLED_AT_EXPR}, o.date)` : "o.date"} AS order_date,
          ${SETTLED_AT_EXPR} AS settled_at,
          COALESCE(o.applied_discount_amount, 0) AS order_discount,
          COALESCE(
            SUM(
              CASE
                WHEN ct.status = 'Success'
                  THEN (CASE WHEN ct.type = 'Return' THEN -ct.amount ELSE ct.amount END)
                ELSE 0
              END
            ),
            0
          )::numeric AS settled_irr,
          COALESCE(
            SUM(CASE WHEN ct.status = 'Success' AND ct.type = 'Return' THEN ct.amount ELSE 0 END),
            0
          )::numeric AS refund_irr
        FROM orders o
        ${leftify(joins.orderToContract)}
        ${leftify(joins.contractToTx)}
        WHERE ${statusGate}
          ${clock === "settlement" ? "" : "AND o.date BETWEEN ? AND ?"}
        GROUP BY o.id, o.date, o.applied_discount_amount
        ${window}
      )
    `;
  }
  return `
    paid_orders AS (
      SELECT
        o.id AS order_id,
        ${clock === "settlement" ? `COALESCE(${SETTLED_AT_EXPR}, o.date)` : "o.date"} AS order_date,
        ${SETTLED_AT_EXPR} AS settled_at,
        COALESCE(o.applied_discount_amount, 0) AS order_discount,
        SUM(CASE WHEN ct.type = 'Return' THEN -ct.amount ELSE ct.amount END)::numeric AS settled_irr,
        COALESCE(SUM(CASE WHEN ct.type = 'Return' THEN ct.amount ELSE 0 END), 0)::numeric AS refund_irr
      FROM orders o
      ${joins.orderToContract}
      ${joins.contractToTx}
      WHERE ct.status = 'Success'
        AND ${statusGate}
        AND ${clock === "settlement" ? "ct.date" : "o.date"} BETWEEN ? AND ?
      GROUP BY o.id, o.date, o.applied_discount_amount
      HAVING SUM(CASE WHEN ct.type = 'Return' THEN -ct.amount ELSE ct.amount END) > 0
    )
  `;
}

/**
 * Choose the paid-orders definition this window can actually describe.
 *
 * `settled` is the correct definition and stays the default. But orders
 * imported from WordPress never got gateway transactions, so on that data a
 * settled-only window matches almost nothing and every series collapses to a
 * single bucket — which is the "chart shows one dot" symptom. When a window
 * holds no successful settlement at all, fall back to completed orders.
 * Callers must surface the returned definition; the two are not interchangeable.
 * Windows on the same column as {@link paidOrdersCte} for the given clock.
 */
export async function resolvePaidOrdersDefinition(
  knex: Knex,
  joins: ResolvedJoins,
  start: Date,
  end: Date,
  clock: ReportClock = "order",
): Promise<PaidOrdersDefinition> {
  const res = await knex.raw(
    `SELECT EXISTS (
       SELECT 1
       FROM orders o
       ${joins.orderToContract}
       ${joins.contractToTx}
       WHERE ct.status = 'Success'
         AND o.status IN (${ELIGIBLE_STATUS_SQL})
         AND ${clock === "settlement" ? "ct.date" : "o.date"} BETWEEN ? AND ?
     ) AS has_settlement`,
    [start, end],
  );
  const row = (res?.rows || res?.[0] || [])[0] || {};
  return row.has_settlement ? "settled" : "completed";
}

/**
 * The channel a settlement leg is attributed to. The importer tags each leg
 * (`settlement_gateway`: a split order has a `Wallet` leg and a gateway leg;
 * an order completed at the branch without an online payment carries
 * `OffGateway`); a leg without a tag — every live checkout transaction —
 * falls back to the order's own gateway.
 */
export function settlementGatewayExpr(joins: ResolvedJoins): string {
  const fallback = "NULLIF(o.payment_gateway, '')";
  return joins.txSettlementGateway
    ? `COALESCE(NULLIF(ct.settlement_gateway, ''), ${fallback}, 'Unknown')`
    : `COALESCE(${fallback}, 'Unknown')`;
}

/**
 * Cash collected per gateway, reusing the canonical `paid_orders` definition.
 *
 * One row per gateway with the number of paid orders that had a leg on it, the
 * net successful settlement of those legs (IRR; divide by 10 for Toman), and the
 * *total* order count whose `orders.payment_gateway` is that gateway. Attribution
 * is per settlement leg, so a split payment lands under both `Wallet` and its
 * gateway — which is what the cash view must show — and the sum of `orders_count`
 * across rows can exceed the number of paid orders. `paid_orders_count` carries
 * the distinct total for footers.
 *
 * Rooted in every order in range (FULL OUTER JOIN), deliberately. This
 * previously read `FROM paid_orders po JOIN orders o`, which meant a gateway with
 * orders but no settled transaction produced **no row at all** — and `withShares`
 * then computed percentages over only the surviving rows, so they summed to a
 * confident 100% with the broken gateway simply absent. A gateway with orders
 * always appears, with `orders_count` 0 against a non-zero `total_orders_count`.
 *
 * Bindings: [start, end, start, end] — the embedded paid_orders CTE is declared
 * first, so its window binds before the all-orders window (always creation date).
 */
export function gatewayBreakdownQuery(
  joins: ResolvedJoins,
  definition: PaidOrdersDefinition = "settled",
  clock: ReportClock = "order",
): string {
  return `
    WITH ${paidOrdersCte(joins, definition, clock)},
    legs AS (
      SELECT
        ${settlementGatewayExpr(joins)} AS gateway,
        COUNT(DISTINCT po.order_id)::bigint AS orders_count,
        SUM(CASE WHEN ct.type = 'Return' THEN -ct.amount ELSE ct.amount END)::numeric AS settled_irr
      FROM paid_orders po
      JOIN orders o ON o.id = po.order_id
      ${joins.orderToContract}
      ${joins.contractToTx}
      WHERE ct.status = 'Success'
      GROUP BY 1
    ),
    all_orders AS (
      SELECT
        COALESCE(NULLIF(o.payment_gateway, ''), 'Unknown') AS gateway,
        COUNT(*)::bigint AS total_orders_count
      FROM orders o
      WHERE o.date BETWEEN ? AND ?
      GROUP BY 1
    )
    SELECT
      COALESCE(l.gateway, a.gateway) AS gateway,
      COALESCE(l.orders_count, 0)::bigint AS orders_count,
      COALESCE(a.total_orders_count, 0)::bigint AS total_orders_count,
      COALESCE(l.settled_irr, 0)::numeric AS settled_irr,
      (SELECT COUNT(*) FROM paid_orders)::bigint AS paid_orders_count
    FROM legs l
    FULL OUTER JOIN all_orders a ON a.gateway = l.gateway
    ORDER BY settled_irr DESC
  `;
}

export type GatewaySettlementRow = {
  gateway: string;
  label: string;
  ordersCount: number;
  totalOrdersCount: number;
  total: number;
};

export type DataQualityWarning = {
  code: string;
  gateway: string;
  message: string;
  ordersCount: number;
};

/**
 * Flags gateways that took orders in the range but settled none of them.
 *
 * Every product report defines a paid sale as `contract_transaction.Status =
 * 'Success'`. A gateway whose settlement path never writes that row contributes
 * zero to every metric — silently, and indistinguishably from "nobody used this
 * gateway". Mellat did exactly this: it had no contract_transaction writer at all,
 * so its revenue was absent from every report with nothing anywhere saying so.
 *
 * This is the generic detector for that class of bug. It is cheap because
 * `gatewayBreakdownQuery` already returns both counts per gateway.
 */
export function gatewaySettlementWarnings(
  rows: GatewaySettlementRow[],
): DataQualityWarning[] {
  return (rows || [])
    .filter(
      (row) =>
        Number(row.totalOrdersCount) > 0 && Number(row.ordersCount) === 0,
    )
    .map((row) => ({
      code: "GATEWAY_NO_SETTLED_ORDERS",
      gateway: row.gateway,
      ordersCount: Number(row.totalOrdersCount),
      message: `درگاه «${row.label}» در این بازه ${row.totalOrdersCount} سفارش دارد اما هیچ تراکنش موفقی ثبت نکرده است؛ فروش این درگاه در گزارش‌ها دیده نمی‌شود.`,
    }));
}

/**
 * Shipping revenue grouped by shipping method, reusing the canonical `paid_orders`
 * definition. Uses the stored `orders.shipping_cost` (Toman) snapshot — NOT product
 * subtotal.
 *
 * The method name is the order's own `shipping_method_title` snapshot first, and
 * the `shippings` relation only as a fallback. Every order carries the snapshot
 * (the storefront and the WooCommerce importer both write it); only storefront
 * orders have the relation, so grouping by the relation alone filed every
 * imported order under «نامشخص». Orders with neither group under the
 * `__UNKNOWN__` sentinel (the controller maps it to "نامشخص"). Bindings: [start, end].
 */
export function shippingBreakdownQuery(
  joins: ResolvedJoins,
  definition: PaidOrdersDefinition = "settled",
  clock: ReportClock = "order",
): string {
  const relationTitle = joins.orderToShipping ? "NULLIF(s.title, '')" : "NULL::text";
  const methodExpr = `COALESCE(NULLIF(o.shipping_method_title, ''), ${relationTitle}, '__UNKNOWN__')`;
  return `
    WITH ${paidOrdersCte(joins, definition, clock)}
    SELECT
      ${methodExpr} AS method,
      COUNT(*)::bigint AS orders_count,
      COALESCE(SUM(o.shipping_cost), 0)::bigint AS shipping_total
    FROM paid_orders po
    JOIN orders o ON o.id = po.order_id
    ${joins.orderToShipping}
    GROUP BY ${methodExpr}
    ORDER BY shipping_total DESC
  `;
}

/**
 * Total shipping fee across the same `paid_orders` set, as one scalar.
 *
 * This is the term that reconciles the money figures the admin shows: the
 * gateway/liquidity pages report cash actually collected, which is merchandise
 * PLUS shipping, while `sales.gross` sums order lines only (`per_amount * count`,
 * see {@link itemizedCte}). It is also the term the sales overview ADDS to reach
 * its store-wide «فروش ناخالص» (`sales.grossWithShipping`) and then subtracts
 * again to reach the merchandise-only «فروش خالص» — decision D16. Finance pages
 * need the scalar, not the per-method grouping of {@link shippingBreakdownQuery},
 * to render that reconciliation — and they are gated on `report.finance.read`,
 * so they cannot borrow the product report's endpoint to get it.
 *
 * `orders.shipping_cost` is stored in Toman, not IRR — do NOT pass this through
 * `irrToToman`.
 */
export function shippingRevenueQuery(
  joins: ResolvedJoins,
  definition: PaidOrdersDefinition = "settled",
  clock: ReportClock = "order",
): string {
  return `
    WITH ${paidOrdersCte(joins, definition, clock)}
    SELECT COALESCE(SUM(o.shipping_cost), 0)::bigint AS shipping_total
    FROM paid_orders po
    JOIN orders o ON o.id = po.order_id
  `;
}

/**
 * The per-line "itemized" CTE built on top of paid_orders. One row per order item
 * of a paid order, carrying the line gross plus the per-order gross (window sum)
 * so order-level discount/refund can be pro-rated to the line. Assumes a
 * `paid_orders` CTE is already declared in the same statement.
 */
export function itemizedCte(joins: ResolvedJoins): string {
  return `
    itemized AS (
      SELECT
        ${joins.oiToVariation.idExpr} AS product_variation_id,
        oi.product_title,
        oi.product_sku,
        oi.count AS cnt,
        (oi.per_amount * oi.count)::numeric AS line_gross,
        o.id AS order_id,
        po.order_date,
        po.order_discount,
        po.refund_irr,
        SUM((oi.per_amount * oi.count)::numeric) OVER (PARTITION BY o.id) AS order_gross
      FROM order_items oi
      ${joins.oiToOrder}
      ${joins.oiToVariation.join}
      JOIN paid_orders po ON po.order_id = o.id
    )
  `;
}

/**
 * The canonical product -> category membership set: the UNION of every membership
 * link table (main category + other categories).
 *
 * `UNION` (not `UNION ALL`) is load-bearing: it collapses a product that is filed
 * under the same category through BOTH relations into one row, so a line item can
 * never be counted twice under a single category. Callers still need their own
 * DISTINCT when rolling membership up the tree — see {@link categoryAncestryCte}.
 *
 * Yields `product_category_membership(product_id, product_category_id)`. When no
 * membership table resolves it yields an empty set with the right column types,
 * so a drifted schema produces an empty category report rather than a SQL error.
 */
export function categoryMembershipCte(joins: ResolvedJoins): string {
  const tables = joins.categoryMembershipTables || [];
  if (tables.length === 0) {
    return `
      product_category_membership AS (
        SELECT NULL::int AS product_id, NULL::int AS product_category_id WHERE false
      )
    `;
  }
  const union = tables
    .map((t) => `SELECT product_id, product_category_id FROM ${t}`)
    .join("\n        UNION\n        ");
  return `
    product_category_membership AS (
        ${union}
    )
  `;
}

/**
 * Every category paired with itself and each of its ancestors, so a sale filed
 * under a leaf can be rolled up to every category that contains it.
 *
 * Yields `category_ancestry(category_id, ancestor_id, up)` where `up` is the number
 * of hops (0 = the category itself). Requires the statement to be `WITH RECURSIVE`.
 * `up < depth` is a cycle guard: a self-referencing category row would otherwise
 * loop forever.
 */
export function categoryAncestryCte(link: CategoryParentLink, maxDepth: number): string {
  const { table, childCol, parentCol } = link;
  return `
    category_ancestry AS (
      SELECT id::bigint AS category_id, id::bigint AS ancestor_id, 0 AS up FROM product_categories
      UNION ALL
      SELECT a.category_id, cl.${parentCol}::bigint, a.up + 1
      FROM category_ancestry a
      JOIN ${table} cl ON cl.${childCol} = a.ancestor_id
      WHERE cl.${parentCol} IS NOT NULL AND a.up < ${maxDepth}
    )
  `;
}

/**
 * A `WHERE`-clause fragment selecting products that belong to a given category —
 * or, when the parent relation resolves, to that category or any of its
 * DESCENDANTS. Matches the storefront's category page, which lists a category
 * together with everything beneath it.
 *
 * Written as `EXISTS` on purpose: a join would multiply a product row once per
 * matching membership/descendant path and inflate every aggregate downstream.
 *
 * Returns `""` when membership can't be resolved, so callers append nothing and
 * fall back to an unfiltered result rather than a broken one. Takes exactly one
 * bound parameter (the category id) when non-empty; `productIdExpr` is the SQL
 * expression naming the product id in the caller's scope.
 */
export function categoryFilterSql(joins: ResolvedJoins, productIdExpr: string): string {
  const tables = joins.categoryMembershipTables || [];
  if (tables.length === 0) return "";

  const membership = tables
    .map(
      (t) =>
        `SELECT 1 FROM ${t} cm WHERE cm.product_id = ${productIdExpr} AND cm.product_category_id IN (SELECT id FROM cat_scope)`,
    )
    .join(" UNION ALL ");

  const link = joins.categoryParentLink;
  const scope = link
    ? `WITH RECURSIVE cat_scope AS (
         SELECT ?::int AS id
         UNION ALL
         SELECT cl.${link.childCol}::int
         FROM ${link.table} cl JOIN cat_scope ON cl.${link.parentCol} = cat_scope.id
       )`
    : `WITH cat_scope AS (SELECT ?::int AS id)`;

  return `EXISTS (${scope} SELECT 1 FROM (${membership}) m)`;
}

/**
 * Aggregate `itemized` to one row per variation (or per SKU when the variation
 * was deleted), with pro-rated discount and refund. Assumes `itemized` is declared.
 *
 * `order_items.product_sku` / `.product_title` are SNAPSHOTS taken at order time,
 * so they are not identity. Grouping by the SKU snapshot split one variation into
 * several rows the moment an import renamed it — a catalog rename made a live
 * product's sales look frozen while a second row quietly collected the new
 * orders. Identity is the variation; the SKU only discriminates rows that have no
 * variation at all (`oiToVariation` is a LEFT JOIN, so NULL is reachable).
 *
 * Title and SKU are then reported from the MOST RECENT line rather than MAX(), so
 * a renamed product shows what the catalog calls it today. `sku_search` and
 * `title_search` keep every historical spelling searchable — collapsing to the
 * newest snapshot alone made an operator's usual search term stop matching the
 * moment an import renamed the product (e.g. "G00700" no longer matches after the
 * title became "G 00700"). The `q` filters in the report controller search these,
 * never the display columns.
 */
export function aggCte(): string {
  return `
    agg AS (
      SELECT
        product_variation_id,
        (ARRAY_AGG(product_title ORDER BY order_date DESC)
           FILTER (WHERE product_title IS NOT NULL))[1] AS product_title,
        (ARRAY_AGG(product_sku ORDER BY order_date DESC)
           FILTER (WHERE product_sku IS NOT NULL))[1] AS product_sku,
        string_agg(DISTINCT product_sku, ' ') AS sku_search,
        string_agg(DISTINCT product_title, ' ') AS title_search,
        SUM(cnt)::bigint AS units,
        SUM(line_gross)::numeric AS gross,
        COUNT(DISTINCT order_id)::bigint AS orders_count,
        SUM(CASE WHEN order_gross > 0 THEN order_discount * line_gross / order_gross ELSE 0 END)::numeric AS discounts,
        SUM(CASE WHEN order_gross > 0 THEN refund_irr * line_gross / order_gross ELSE 0 END)::numeric AS refunds_irr
      FROM itemized
      GROUP BY product_variation_id,
               CASE WHEN product_variation_id IS NULL THEN product_sku END
    )
  `;
}

/**
 * One row per variation carrying its FULL identity: colour, size, model, and every
 * custom attribute.
 *
 * A variation describes itself through two disjoint mechanisms, and reading only
 * one drops half its identity:
 *
 * - Three dedicated oneToOne relations (see {@link ResolvedJoins.variationToColor}),
 *   whose ids point at `product_variation_colors` / `_sizes` / `_models`.
 * - `selected_attribute_terms`, whose ids point at `product_attribute_terms`.
 *
 * `buildVariationCombinations` in `product/services/variation-combinations.ts`
 * routes each axis to exactly ONE of the two, and `signatureFromVariation` — the
 * canonical identity of a variation — unions both with no dedupe. So per variation
 * the two sets never overlap, which is what makes the COALESCE below safe.
 * `product_attributes.legacy_projection` is a presentation hint, not a second copy:
 * the importer's repair script only ever assigns generic terms whose projection is
 * 'None'. The projected branches are defensive, and nothing is ever hidden because
 * `attrs` carries every term unfiltered.
 *
 * `DISTINCT ON (pv.id)` is the load-bearing safety property: it guarantees exactly
 * one row per variation whatever the link tables contain, so the single outer join
 * onto this CTE cannot multiply rows — and `countSql`'s total and the pagination
 * are therefore provably unaffected by this feature.
 *
 * Declares NO bindings. With `scope: "agg"` it restricts itself to variations that
 * actually sold (`productPerformance` issues its SQL twice per request, so the
 * narrower scan is worth it) and must be declared AFTER `agg`. With `scope: "all"`
 * it covers every variation, which the detail and inventory queries need because
 * they list variations that never sold; both already scan `product_variations`
 * wholesale.
 */
export function variationAttributesCte(
  joins: ResolvedJoins,
  scope: "agg" | "all" = "agg",
): string {
  const color = joins.variationToColor.titleExpr;
  const scopeJoin = scope === "agg" ? "JOIN agg ON agg.product_variation_id = pv.id" : "";
  return `
    variation_attributes AS (
      SELECT DISTINCT ON (pv.id)
        pv.id AS pvid,
        COALESCE(${color}, ga.gen_color) AS variant_color,
        -- CASE, not COALESCE: a legacy colour with no swatch must not borrow a
        -- different attribute's colour code.
        CASE WHEN ${color} IS NOT NULL THEN ${joins.variationToColor.codeExpr}
             ELSE ga.gen_color_code END AS variant_color_code,
        COALESCE(${joins.variationToSize.titleExpr}, ga.gen_size)   AS variant_size,
        COALESCE(${joins.variationToModel.titleExpr}, ga.gen_model) AS variant_model,
        ga.other_attrs AS variant_other,
        COALESCE(ga.attrs, '[]'::jsonb) AS variant_attrs
      FROM product_variations pv
      ${scopeJoin}
      ${joins.variationToColor.join}
      ${joins.variationToSize.join}
      ${joins.variationToModel.join}
      LEFT JOIN (${genericAttributesSelect(joins)}) ga ON ga.pvid = pv.id
      ORDER BY pv.id
    )
  `;
}

/**
 * The generic-attribute aggregate feeding {@link variationAttributesCte}.
 *
 * Custom attributes (جنس, طرح, …) are folded into one «نام: مقدار» string because
 * the xlsx export needs a fixed column count; `attrs` keeps the structured list for
 * the drawer. Degrades to an empty set — still correctly typed — when the generic
 * link tables are absent, so a database lagging that migration keeps the colour and
 * size it already has.
 */
function genericAttributesSelect(joins: ResolvedJoins): string {
  const EMPTY = `
        SELECT NULL::int AS pvid, NULL::text AS gen_color, NULL::text AS gen_color_code,
               NULL::text AS gen_size, NULL::text AS gen_model,
               NULL::text AS other_attrs, NULL::jsonb AS attrs
        WHERE false`;
  if (!joins.hasVariationAttributes) return EMPTY;
  // Both positions default to 0, so the title tiebreakers carry the ordering for
  // most catalogues — do not drop them.
  const termOrder = "COALESCE(pa.position, 0), COALESCE(pat.position, 0), pat.id";
  const projected = (column: string, projection: string) =>
    `(ARRAY_AGG(${column} ORDER BY ${termOrder})
            FILTER (WHERE pa.legacy_projection = '${projection}'))[1]`;
  return `
        SELECT
          vl.product_variation_id AS pvid,
          ${projected("pat.title", "Color")} AS gen_color,
          ${projected("pat.color_code", "Color")} AS gen_color_code,
          ${projected("pat.title", "Size")}  AS gen_size,
          ${projected("pat.title", "Model")} AS gen_model,
          string_agg(
            CASE WHEN pa.title IS NULL OR btrim(pa.title) = '' THEN pat.title
                 ELSE pa.title || ': ' || pat.title END,
            '، ' ORDER BY ${termOrder}
          ) FILTER (WHERE COALESCE(pa.legacy_projection, 'None') = 'None') AS other_attrs,
          jsonb_agg(
            jsonb_build_object(
              'name', pa.title, 'value', pat.title,
              'colorCode', pat.color_code,
              'projection', COALESCE(pa.legacy_projection, 'None')
            ) ORDER BY ${termOrder}
          ) AS attrs
        FROM ${VARIATION_TERM_LINK_TABLE} vl
        JOIN product_attribute_terms pat ON pat.id = vl.product_attribute_term_id
        LEFT JOIN ${TERM_ATTRIBUTE_LINK_TABLE} patal
               ON patal.product_attribute_term_id = pat.id
        LEFT JOIN product_attributes pa ON pa.id = patal.product_attribute_id
        GROUP BY vl.product_variation_id`;
}

/**
 * The variant-identity SELECT columns, shared by every variant-grained query.
 * Requires a {@link variationAttributesCte} join aliased `va` to be in scope.
 *
 * `withAttrs` adds the raw jsonb attribute array. Only the drawer renders it; the
 * table and its 10k-row export would carry the payload for nothing.
 */
export function variantColumnsSelect(withAttrs = false): string {
  return `
      va.variant_color,
      va.variant_color_code,
      va.variant_size,
      va.variant_model,
      va.variant_other${withAttrs ? ",\n      va.variant_attrs" : ""}`;
}

/**
 * Join to {@link variationAttributesCte}. `idExpr` is the variation id to key on,
 * which differs per call site (`agg.product_variation_id` vs `pv.id`). One join,
 * and the CTE is 1:1, so this can never multiply rows.
 */
export function variantJoins(idExpr: string): string {
  return `LEFT JOIN variation_attributes va ON va.pvid = ${idExpr}`;
}

/**
 * Shape the variant columns of any raw row into the API payload (pure).
 * Mirrors what {@link serializeProductRow} does for the performance table.
 */
export function serializeVariantIdentity(row: {
  variant_color?: string | null;
  variant_color_code?: string | null;
  variant_size?: string | null;
  variant_model?: string | null;
  variant_other?: string | null;
  variant_attrs?: unknown;
}) {
  const variantColor = variantText(row.variant_color);
  const variantSize = variantText(row.variant_size);
  const variantModel = variantText(row.variant_model);
  return {
    variantColor,
    variantColorCode: variantText(row.variant_color_code),
    variantSize,
    variantModel,
    variantOther: variantText(row.variant_other),
    variantLabel: variantLabel({ color: variantColor, size: variantSize, model: variantModel }),
    variantAttrs: Array.isArray(row.variant_attrs) ? row.variant_attrs : [],
  };
}

/**
 * Total stock across EVERY variation of each product that appears in `agg`.
 *
 * The performance table is variant-grained, so its `ps.count` is ONE variant's
 * stock — operators read it as the product's, and searching a product code showed
 * 6 where the product held ~40. This supplies the product-level figure so both can
 * be shown side by side, correctly labelled.
 *
 * MUST stay identical to `productDetail`'s `totals.currentStock` for the same
 * product: same inner product join, same LEFT stock join, no IsPublished /
 * removed_at filter, nulls counted as 0. A third number for the same question is
 * the very bug this fixes.
 *
 * Declares NO bindings, and MUST be declared after `agg`. Scoped to `agg`'s
 * products because `productPerformance` runs this SQL twice per request and the
 * count query never reads the result.
 */
export function productStockTotalsCte(joins: ResolvedJoins): string {
  return `
    sold_products AS (
      SELECT DISTINCT p.id AS product_id
      FROM agg
      JOIN product_variations pv ON pv.id = agg.product_variation_id
      ${joins.variationToProduct}
    ),
    product_stock_totals AS (
      SELECT
        p.id AS product_id,
        SUM(COALESCE(ps.count, 0))::bigint          AS total_stock,
        SUM(COALESCE(ps.reserved_count, 0))::bigint AS total_reserved,
        COUNT(pv.id)::bigint                        AS variation_count
      FROM product_variations pv
      ${joins.variationToProduct}
      ${joins.variationToStock}
      JOIN sold_products sp ON sp.product_id = p.id
      GROUP BY p.id
    )
  `;
}

/**
 * The full `WITH` list behind the product performance table and its xlsx export.
 *
 * Order is load-bearing: `variation_attributes` and `product_stock_totals` both
 * reference `agg`. Only `paid_orders` declares bindings, so callers keep passing
 * `[start, end, ...filters]` positionally.
 */
export function performanceCtes(joins: ResolvedJoins): string {
  return [
    paidOrdersCte(joins),
    itemizedCte(joins),
    aggCte(),
    variationAttributesCte(joins),
    productStockTotalsCte(joins),
  ].join(", ");
}

/**
 * The enrichment SELECT that joins `agg` to current product / category / stock
 * data. Returns the SELECT + FROM/JOINs (no WHERE / ORDER / LIMIT) so callers can
 * append filters and paging. Columns line up with {@link RawPerformanceRow}.
 */
export function performanceCoreSelect(joins: ResolvedJoins): string {
  const variationToProductLeft = leftify(joins.variationToProduct);
  const hasCategory = Boolean(joins.productToCategory.join);
  const categoryIdExpr = hasCategory ? "pc.id" : "NULL::int";
  return `
    SELECT
      agg.product_variation_id,
      p.id AS product_id,
      agg.product_title,
      agg.product_sku,
      p.product_type,
      ${joins.productToCategory.titleExpr} AS category_title,
      ${categoryIdExpr} AS category_id,
      agg.units,
      agg.gross,
      agg.discounts,
      agg.refunds_irr,
      agg.orders_count,
      -- Derived columns exist ONLY so PERFORMANCE_SORT_COLUMNS can ORDER BY them;
      -- serializeProductRow still computes the values it returns. Keep these three
      -- in step with it (net floors at 0, avgPrice divides gross, IRR/10 -> Toman)
      -- or the table sorts by one number and displays another.
      GREATEST(0, agg.gross - agg.discounts - (agg.refunds_irr / 10.0)) AS net,
      (agg.refunds_irr / 10.0) AS refunds,
      CASE WHEN agg.units > 0 THEN agg.gross / agg.units ELSE 0 END AS avg_price,
      ps.count AS current_stock,
      ps.reserved_count AS reserved_stock,
      ${variantColumnsSelect()},
      pst.total_stock     AS product_total_stock,
      pst.variation_count AS product_variation_count
    FROM agg
    LEFT JOIN product_variations pv ON pv.id = agg.product_variation_id
    ${variationToProductLeft}
    ${joins.variationToStock}
    ${joins.productToCategory.join}
    ${variantJoins("agg.product_variation_id")}
    LEFT JOIN product_stock_totals pst ON pst.product_id = p.id
  `;
}

/** Turn an inner-JOIN fragment into LEFT JOINs (used where the left row may be null). */
export function leftify(fragment: string): string {
  // Only safe for fragments that contain plain `JOIN` (no existing LEFT/RIGHT).
  return fragment.replace(/(^|\s)JOIN\s/g, "$1LEFT JOIN ");
}

/** date_trunc expression that buckets a UTC timestamp in the report timezone. */
export function tzBucketExpr(column: string, grouping: Grouping): string {
  // (col AT TIME ZONE 'UTC') reinterprets the stored timestamp as UTC, then
  // AT TIME ZONE tz shifts it to local wall-clock before truncating.
  return `date_trunc('${grouping}', (${column} AT TIME ZONE 'UTC') AT TIME ZONE '${REPORT_TIMEZONE}')`;
}

/** A stored UTC timestamp as wall-clock time in the report timezone (for EXTRACT). */
export function tzWallClockExpr(column: string): string {
  return `((${column} AT TIME ZONE 'UTC') AT TIME ZONE '${REPORT_TIMEZONE}')`;
}

/**
 * {@link tzBucketExpr} rendered as a `YYYY-MM-DD` text key.
 *
 * `date_trunc` yields `timestamp without time zone`, which node-postgres parses
 * into a JS `Date` in the *server's* local zone. Every bucket consumer keys on
 * the Tehran calendar date, so the key is produced in SQL where the zone is
 * known, and no JS-side parsing can shift it.
 */
export function tzBucketKeyExpr(column: string, grouping: Grouping): string {
  return `to_char(${tzBucketExpr(column, grouping)}, 'YYYY-MM-DD')`;
}

const EMPTY_TREND_POINT: Omit<TrendPoint, "bucket"> = {
  gross: 0,
  net: 0,
  units: 0,
  orders: 0,
  discounts: 0,
  refunds: 0,
};

/** Iran has no DST; this matches `REPORT_TZ_OFFSET` in the report controller. */
const TEHRAN_NOON_OFFSET = "+03:30";

export function tehranYmd(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localYmd(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Normalise a SQL bucket to its `YYYY-MM-DD` key.
 *
 * Buckets should arrive as text (see {@link tzBucketKeyExpr}). A `Date` is what
 * node-postgres makes of a bare `timestamp` — parsed in the server's local zone
 * — so it is read back in that same zone, which returns the wall-clock date the
 * database emitted regardless of where the server runs. `String(date)` used to
 * be matched against `^\d{4}-\d{2}-\d{2}` here, which never matches
 * `"Mon Aug 03 2026 …"`, so no SQL row ever met its calendar key and every
 * trend charted as a flat zero line.
 */
export function bucketDateKey(raw: string | Date): string {
  if (raw instanceof Date) return localYmd(raw);
  const match = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : String(raw);
}

function tehranNoon(ymd: string): Date {
  return new Date(`${ymd}T12:00:00${TEHRAN_NOON_OFFSET}`);
}

function alignBucketKey(ymd: string, grouping: Grouping): string {
  if (grouping === "day") return ymd;
  if (grouping === "month") return `${ymd.slice(0, 7)}-01`;
  const noon = tehranNoon(ymd);
  const daysFromMonday = (noon.getUTCDay() + 6) % 7;
  noon.setUTCDate(noon.getUTCDate() - daysFromMonday);
  return tehranYmd(noon);
}

function nextBucketKey(ymd: string, grouping: Grouping): string {
  if (grouping === "month") {
    const year = Number(ymd.slice(0, 4));
    const month = Number(ymd.slice(5, 7));
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
  }
  const noon = tehranNoon(ymd);
  noon.setUTCDate(noon.getUTCDate() + (grouping === "week" ? 7 : 1));
  return tehranYmd(noon);
}

/**
 * SQL only returns buckets that had activity, so a 7-day window with one sale
 * used to chart as a single point. Fill the missing Tehran calendar buckets
 * with zeros so the series length matches the requested grouping.
 */
export function fillTrendSeries(
  points: TrendPoint[],
  start: Date,
  end: Date,
  grouping: Grouping,
): TrendPoint[] {
  return fillBucketSeries(points, start, end, grouping, EMPTY_TREND_POINT);
}

/**
 * Generic form of {@link fillTrendSeries}: any series keyed by `bucket`, filled
 * with `empty` for the Tehran calendar buckets SQL did not return.
 */
export function fillBucketSeries<T extends { bucket: string | Date }>(
  points: T[],
  start: Date,
  end: Date,
  grouping: Grouping,
  empty: Omit<T, "bucket">,
): Array<Omit<T, "bucket"> & { bucket: string }> {
  const byKey = new Map<string, T>();
  for (const point of points) {
    byKey.set(alignBucketKey(bucketDateKey(point.bucket), grouping), point);
  }

  const startKey = alignBucketKey(tehranYmd(start), grouping);
  const endKey = alignBucketKey(tehranYmd(end), grouping);
  const filled: Array<Omit<T, "bucket"> & { bucket: string }> = [];
  let cursor = startKey;
  for (let i = 0; i < 4000 && cursor <= endKey; i += 1) {
    const existing = byKey.get(cursor);
    filled.push(existing ? { ...existing, bucket: cursor } : { ...empty, bucket: cursor });
    cursor = nextBucketKey(cursor, grouping);
  }
  return filled;
}
