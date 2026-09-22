/**
 * Report controller
 */

import { MANAGEMENT_ROLES } from "../../../utils/roles";
import { hasCapability, type AdminCapability } from "@repo/auth-core";
import { requireCapability } from "../../../utils/adminAuthorization";
import * as productAnalytics from "../services/product-analytics";
import { buildStyledWorkbook, WorkbookColumn } from "../../../utils/styledWorkbook";
import {
  getSalesBreakdown,
  SALES_BREAKDOWN_DIMENSIONS,
  type SalesBreakdownDimension,
} from "../analytics/semantic/salesBreakdown";
import { METRIC_CATALOG } from "../analytics/metrics/catalog";
import {
  getUmamiBehaviorReport,
  getUmamiRealtimeReport,
  isUmamiConfigured,
  normalizeRange,
  normalizeUmamiFilters,
  previousRange,
  UMAMI_DEFINITION_VERSION,
  UMAMI_REPORT_TIMEZONE,
} from "../services/umami";

async function getProductBehavioralUmami(
  slug: string,
  range: { startDate: string; endDate: string },
) {
  if (!slug || !isUmamiConfigured()) return null;
  try {
    const report = await getUmamiBehaviorReport("content", range);
    const rows = Array.isArray(report.sections.path) ? (report.sections.path as Array<any>) : [];
    const needle = `/pdp/${slug}`.toLowerCase();
    const match = rows.find((row) =>
      String(row?.label || "")
        .toLowerCase()
        .includes(needle),
    );
    if (!match) return { pageviews: 0, uniquePageviews: 0, avgTimeOnPageSec: 0, bounceRate: 0 };
    return {
      pageviews: Number(match.pageviews || 0),
      uniquePageviews: Number(match.visits || match.visitors || 0),
      avgTimeOnPageSec:
        Number(match.visits || 0) > 0 ? Number(match.totaltime || 0) / Number(match.visits) : 0,
      bounceRate:
        Number(match.visits || 0) > 0
          ? (Number(match.bounces || 0) / Number(match.visits)) * 100
          : 0,
    };
  } catch {
    return null;
  }
}

type Interval = "day" | "week" | "month";
type AdminActivityResourceScope = "all" | "order" | "product";

const behaviorCache = new Map<string, { createdAt: number; payload: any }>();
const behaviorPromises = new Map<string, Promise<any>>();
const BEHAVIOR_CACHE_LIMIT = 500;

type BehaviorKind =
  | "overview"
  | "acquisition"
  | "conversion"
  | "content"
  | "audience"
  | "performance";

function hasMeaningfulBehaviorValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMeaningfulBehaviorValue);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasMeaningfulBehaviorValue);
  }
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") return value.trim().length > 0;
  return value === true;
}

function behaviorStatus(report: any): "ok" | "empty" | "partial" | "unavailable" {
  if (!isUmamiConfigured() || report?.errors?.source) return "unavailable";
  const sectionValues = Object.entries(report?.sections || {}).filter(([key]) => key !== "summary");
  if (
    Object.keys(report?.sections || {}).length === 0 &&
    Object.keys(report?.errors || {}).length > 0
  ) {
    return "unavailable";
  }
  if (Object.keys(report?.errors || {}).length > 0) return "partial";
  const hasData = sectionValues.some(([, value]) => hasMeaningfulBehaviorValue(value));
  const summary = report?.summary || report?.sections?.summary;
  const hasSummary = hasMeaningfulBehaviorValue(summary);
  return hasData || hasSummary ? "ok" : "empty";
}

function setBehaviorCache(key: string, payload: any, createdAt = Date.now()) {
  behaviorCache.delete(key);
  behaviorCache.set(key, { createdAt, payload });
  while (behaviorCache.size > BEHAVIOR_CACHE_LIMIT) {
    const oldestKey = behaviorCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    behaviorCache.delete(oldestKey);
  }
}

function behaviorMeta(
  status: "ok" | "empty" | "partial" | "unavailable",
  range: { startDate: string; endDate: string },
  cache: "fresh" | "stale" | "miss",
  refreshedAt: string,
  comparisonRange: { startDate: string; endDate: string } | null = null,
) {
  return {
    source: "umami",
    timezone: UMAMI_REPORT_TIMEZONE,
    unit: "count",
    currency: "IRR",
    definitionVersion: UMAMI_DEFINITION_VERSION,
    dataStart: /^\d{4}-\d{2}-\d{2}$/.test(String(process.env.UMAMI_DATA_START_DATE || ""))
      ? String(process.env.UMAMI_DATA_START_DATE)
      : "2026-08-09",
    refreshedAt,
    cache,
    status,
    requestedRange: { start: range.startDate, end: range.endDate },
    comparisonRange: comparisonRange
      ? { start: comparisonRange.startDate, end: comparisonRange.endDate }
      : null,
  };
}

function behaviorCacheKey(
  kind: BehaviorKind,
  range: { startDate: string; endDate: string },
  filters: Record<string, string>,
  advanced: boolean,
  comparison: boolean,
) {
  const filterKey = Object.entries(filters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${process.env.UMAMI_BASE_URL || process.env.UMAMI_URL || ""}:${process.env.UMAMI_WEBSITE_ID || ""}:${kind}:${range.startDate}:${range.endDate}:${advanced ? "advanced" : "basic"}:${comparison ? "previous" : "none"}:${filterKey}`;
}

type BehaviorReadOptions = {
  advanced?: boolean;
  filters?: Record<string, unknown>;
  fresh?: boolean;
  comparison?: boolean;
};

async function readBehaviorReport(
  kind: BehaviorKind,
  range: { startDate: string; endDate: string },
  options: BehaviorReadOptions = {},
) {
  const filters = normalizeUmamiFilters(options.filters || {});
  const wantsComparison = Boolean(options.comparison);
  const comparisonRange = wantsComparison ? previousRange(range) : null;
  const key = behaviorCacheKey(kind, range, filters, Boolean(options.advanced), wantsComparison);
  const now = Date.now();
  const cached = behaviorCache.get(key);
  const freshTtl = options.advanced ? 5 * 60_000 : 60_000;
  const staleTtl = options.advanced ? 5 * 60_000 : 5 * 60_000;
  if (!options.fresh && cached && now - cached.createdAt <= freshTtl) {
    return { ...cached.payload, meta: { ...cached.payload.meta, cache: "fresh" } };
  }

  const existingPromise = behaviorPromises.get(key);
  if (existingPromise) return existingPromise;

  const reportPromise = (async () => {
    const providerOptions = { advanced: options.advanced, filters };
    const [report, comparisonReport] = await Promise.all([
      getUmamiBehaviorReport(kind, range, providerOptions),
      comparisonRange
        ? getUmamiBehaviorReport(kind, comparisonRange, providerOptions)
        : Promise.resolve(null),
    ]);
    const currentStatus = behaviorStatus(report);
    const comparisonStatus = comparisonReport ? behaviorStatus(comparisonReport) : null;
    if (
      currentStatus === "unavailable" &&
      cached &&
      now - cached.createdAt <= freshTtl + staleTtl
    ) {
      return {
        ...cached.payload,
        meta: {
          ...cached.payload.meta,
          cache: "stale",
          status: "partial",
          warnings: [
            ...(cached.payload.meta?.warnings || []),
            "Umami is unavailable; showing the last successful response.",
          ],
        },
      };
    }
    const status =
      currentStatus === "unavailable"
        ? "unavailable"
        : currentStatus === "partial" ||
            comparisonStatus === "partial" ||
            comparisonStatus === "unavailable"
          ? "partial"
          : currentStatus;
    const data =
      currentStatus === "unavailable"
        ? null
        : {
            ...report,
            ...(comparisonReport
              ? {
                  comparison:
                    comparisonStatus === "unavailable"
                      ? null
                      : { ...comparisonReport, status: comparisonStatus },
                  comparisonStatus,
                }
              : {}),
          };
    const payload = {
      data,
      meta: behaviorMeta(status, range, "miss", new Date().toISOString(), comparisonRange),
    };
    if (currentStatus !== "unavailable") {
      setBehaviorCache(key, payload);
    }
    return payload;
  })().finally(() => {
    if (behaviorPromises.get(key) === reportPromise) behaviorPromises.delete(key);
  });
  behaviorPromises.set(key, reportPromise);
  return reportPromise;
}

function behaviorRequestOptions(ctx: any, advanced = false): BehaviorReadOptions {
  const comparison = String(ctx.query.comparison || "none");
  if (!["none", "previous_period"].includes(comparison)) {
    throw new Error("INVALID_COMPARISON");
  }
  return {
    advanced,
    filters: ctx.query,
    fresh: String(ctx.query.fresh || "") === "1",
    comparison: comparison === "previous_period",
  };
}

async function readBehaviorRealtime() {
  const key = `realtime:${process.env.UMAMI_BASE_URL || process.env.UMAMI_URL || ""}:${process.env.UMAMI_WEBSITE_ID || ""}`;
  const now = Date.now();
  const cached = behaviorCache.get(key);
  if (cached && now - cached.createdAt <= 10_000) {
    return { ...cached.payload, meta: { ...cached.payload.meta, cache: "fresh" } };
  }
  const result = await getUmamiRealtimeReport();
  const status = result.error
    ? "unavailable"
    : result.activeVisitors || result.topPages.length
      ? "ok"
      : "empty";
  if (result.error && cached && now - cached.createdAt <= 5 * 60_000) {
    return {
      ...cached.payload,
      meta: {
        ...cached.payload.meta,
        cache: "stale",
        status: "partial",
        warnings: [
          ...(cached.payload.meta?.warnings || []),
          "Umami realtime is unavailable; showing the last successful response.",
        ],
      },
    };
  }
  const range = normalizeRange();
  const payload = {
    data: result.error ? null : result,
    meta: behaviorMeta(status, range, "miss", new Date().toISOString()),
  };
  if (!result.error) setBehaviorCache(key, payload, now);
  return payload;
}

async function getAnalyticsDeliveryHealth(knex: any) {
  try {
    const result = await knex.raw(
      `SELECT
         COUNT(*)::bigint AS total,
         COUNT(*) FILTER (WHERE status = 'pending')::bigint AS pending,
         COUNT(*) FILTER (WHERE status = 'processing')::bigint AS processing,
         COUNT(*) FILTER (WHERE status = 'dead_letter')::bigint AS dead_letter,
         MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at,
         MAX(sent_at) AS last_sent_at
       FROM analytics_outbox`,
    );
    const row = rowsOf(result)[0] || {};
    const pending = Number(row.pending || 0);
    const processing = Number(row.processing || 0);
    const deadLetter = Number(row.dead_letter || 0);
    return {
      status: deadLetter > 0 ? "attention" : pending > 0 || processing > 0 ? "pending" : "healthy",
      total: Number(row.total || 0),
      pending,
      processing,
      deadLetter,
      oldestPendingAt: row.oldest_pending_at || null,
      lastSentAt: row.last_sent_at || null,
    };
  } catch (error: any) {
    strapi.log?.warn?.("[analytics] delivery health unavailable", {
      error: String(error?.message || error).slice(0, 300),
    });
    return null;
  }
}

/** Tehran offset, matching productAnalytics.tzBucketExpr's REPORT_TIMEZONE. */
const REPORT_TZ_OFFSET = "+03:30";
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a `YYYY-MM-DD` boundary in Tehran, the same zone the SQL buckets in.
 *
 * Parsing a date-only string with `new Date(value)` reads it as UTC midnight,
 * which turns the requested window into [start 03:30, end 03:30] Tehran: the
 * first day loses 3.5 hours and the last day is dropped almost entirely. With
 * an end of "today" that silently discarded today's orders.
 */
function tehranBoundary(value: string, boundary: "start" | "end"): Date | null {
  if (!DATE_ONLY_PATTERN.test(value)) return null;
  const time = boundary === "start" ? "00:00:00.000" : "23:59:59.999";
  const parsed = new Date(`${value}T${time}${REPORT_TZ_OFFSET}`);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A missing value falls back to the default window, which is deliberate. A value
 * that is PRESENT but unparseable throws instead of quietly becoming "now": the
 * old fallback handed the operator plausible-looking numbers for a window they
 * never asked for, with nothing on screen to say so. `INVALID_DATE_RANGE` is the
 * same token the behavior/overview endpoints raise, so both halves of the report
 * API now fail the same way for the same input.
 */
function parseDate(
  value?: string,
  fallbackDays = 30,
  boundary: "start" | "end" = "start",
): Date {
  if (!value) {
    const d = new Date();
    d.setDate(d.getDate() - fallbackDays);
    return d;
  }
  const localBoundary = tehranBoundary(value, boundary);
  if (localBoundary) return localBoundary;
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new Error("INVALID_DATE_RANGE");
  return d;
}

async function ensureCapability(ctx: any, capability: AdminCapability) {
  return requireCapability(ctx, strapi, capability);
}

const normalizeResourceScope = (value: unknown): AdminActivityResourceScope => {
  const normalized = String(value || "all")
    .trim()
    .toLowerCase();
  if (normalized === "order" || normalized === "product") return normalized;
  return "all";
};

const uniqueStrings = (values: Array<string | number | null | undefined>) =>
  Array.from(
    new Set(
      values
        .filter((value) => value !== null && value !== undefined && String(value).trim())
        .map((value) => String(value).trim()),
    ),
  );

const numericSearchId = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function resolveAdminActivityResourceIds(
  search: string,
  scope: AdminActivityResourceScope,
): Promise<{ orderIds: string[]; productIds: string[] }> {
  const term = search.trim();
  if (!term) return { orderIds: [], productIds: [] };

  const id = numericSearchId(term);
  let productIds: string[] = [];
  let orderIds: string[] = [];

  if (scope === "all" || scope === "product") {
    const productOr: any[] = [
      { Title: { $containsi: term } },
      { Slug: { $containsi: term } },
      { external_id: { $containsi: term } },
      { product_variations: { SKU: { $containsi: term } } },
    ];
    if (id) productOr.unshift({ id: { $eq: id } });

    const products = (await strapi.entityService.findMany("api::product.product" as any, {
      filters: { $or: productOr },
      fields: ["id"],
      pagination: { page: 1, pageSize: 100 },
    })) as Array<{ id?: number | string }> | null;

    productIds = uniqueStrings((products || []).map((product) => product.id));
    if (id) productIds = uniqueStrings([String(id), ...productIds]);
  }

  if (scope === "all" || scope === "order") {
    const orderOr: any[] = [
      { external_id: { $containsi: term } },
      { ShippingBarcode: { $containsi: term } },
      { order_items: { ProductTitle: { $containsi: term } } },
      { order_items: { ProductSKU: { $containsi: term } } },
    ];
    if (id) orderOr.unshift({ id: { $eq: id } });
    if (productIds.length > 0) {
      orderOr.push({
        order_items: {
          product_variation: {
            product: {
              id: { $in: productIds.map(Number).filter((value) => Number.isFinite(value)) },
            },
          },
        },
      });
    }

    const orders = (await strapi.entityService.findMany("api::order.order" as any, {
      filters: { $or: orderOr },
      fields: ["id"],
      pagination: { page: 1, pageSize: 200 },
    })) as Array<{ id?: number | string }> | null;

    orderIds = uniqueStrings((orders || []).map((order) => order.id));
    if (id) orderIds = uniqueStrings([String(id), ...orderIds]);
  }

  if ((scope === "all" || scope === "product") && productIds.length > 0) {
    const ordersForProducts = (await strapi.entityService.findMany("api::order.order" as any, {
      filters: {
        order_items: {
          product_variation: {
            product: {
              id: { $in: productIds.map(Number).filter((value) => Number.isFinite(value)) },
            },
          },
        },
      },
      fields: ["id"],
      pagination: { page: 1, pageSize: 200 },
    })) as Array<{ id?: number | string }> | null;
    orderIds = uniqueStrings([...orderIds, ...(ordersForProducts || []).map((order) => order.id)]);
  }

  return { orderIds, productIds };
}

async function applyAdminActivityResourceSearch(filters: any, ctx: any) {
  const resourceSearch = String(ctx.query.resourceSearch || "").trim();
  if (!resourceSearch) return;

  const resourceScope = normalizeResourceScope(ctx.query.resourceScope);
  const { orderIds, productIds } = await resolveAdminActivityResourceIds(
    resourceSearch,
    resourceScope,
  );

  const resourceFilters: any[] = [];
  if (resourceScope === "all" || resourceScope === "order" || orderIds.length > 0) {
    if (orderIds.length > 0) {
      resourceFilters.push({ ResourceType: "Order", ResourceId: { $in: orderIds } });
    }
  }
  if (resourceScope === "all" || resourceScope === "product") {
    if (productIds.length > 0) {
      resourceFilters.push({ ResourceType: "Product", ResourceId: { $in: productIds } });
    }
  }

  if (resourceFilters.length === 0) {
    filters.ResourceId = "__no_matching_resource__";
    return;
  }

  filters.$and = [...(filters.$and || []), { $or: resourceFilters }];
}

const PA = productAnalytics;

/**
 * Visit-to-payment counts for the behaviour dashboard. Gates on
 * {@link productAnalytics.PAID_ORDER_STATUSES} — «سفارش پرداخت‌شده» means the money
 * landed, so status alone decides membership and no settlement gate applies. Money
 * figures use ELIGIBLE_ORDER_STATUSES, the same status list since D15 but additionally
 * gated on net-positive settlement; these two are deliberately different questions and
 * neither page shows the other's number.
 */
async function getOrderStats(start: Date, end: Date) {
  const knex = strapi.db.connection;

  // Strapi usually maps attributes to snake_case lower-case columns.
  try {
    const primaryRes = await knex.raw(
      `SELECT
         COUNT(*)::bigint AS total_orders,
         COUNT(*) FILTER (WHERE o.status IN (${PA.PAID_STATUS_SQL}))::bigint AS paid_orders
       FROM orders o
       WHERE o.date BETWEEN ? AND ?`,
      [start, end],
    );
    const row = (primaryRes.rows || primaryRes[0] || [])[0] || {};
    return {
      totalOrders: Number(row.total_orders || 0),
      paidOrders: Number(row.paid_orders || 0),
    };
  } catch {
    // Some DBs may preserve legacy quoted column names.
    const fallbackRes = await knex.raw(
      `SELECT
         COUNT(*)::bigint AS total_orders,
         COUNT(*) FILTER (WHERE o."Status" IN (${PA.PAID_STATUS_SQL}))::bigint AS paid_orders
       FROM orders o
       WHERE o."Date" BETWEEN ? AND ?`,
      [start, end],
    );
    const row = (fallbackRes.rows || fallbackRes[0] || [])[0] || {};
    return {
      totalOrders: Number(row.total_orders || 0),
      paidOrders: Number(row.paid_orders || 0),
    };
  }
}

async function getRevenueToman(start: Date, end: Date) {
  const knex = strapi.db.connection;
  const revenueRes = await knex.raw(
    `SELECT
       COALESCE(SUM(CASE WHEN ct.type = 'Return' THEN -ct.amount ELSE ct.amount END), 0)::bigint AS total_irr
     FROM contract_transactions ct
     WHERE ct.status = 'Success' AND ct.date BETWEEN ? AND ?`,
    [start, end],
  );
  const row = (revenueRes.rows || revenueRes[0] || [])[0] || {};
  return Number(row.total_irr || 0) / 10;
}

async function getBehaviorCommerce(range: { startDate: string; endDate: string }) {
  // Revenue and paid-order counts are money figures, so the comparison window
  // the conversion report asks for is floored like every other report.
  const { start, end } = PA.clampToFinancialFloor({
    start: parseDate(range.startDate, 30, "start"),
    end: parseDate(range.endDate, 0, "end"),
  });
  const [orderStats, revenueToman] = await Promise.all([
    getOrderStats(start, end),
    getRevenueToman(start, end),
  ]);
  return {
    source: "commerce",
    currency: "Toman",
    paidOrders: orderStats.paidOrders,
    totalOrders: orderStats.totalOrders,
    revenueToman,
  };
}

// ---------------------------------------------------------------------------
// Product reporting helpers (shared by the new /reports/products/* endpoints).
// ---------------------------------------------------------------------------

/**
 * Parse and validate a [start, end] window from the query string, then clamp
 * it to the financial data floor (see `PA.FINANCIAL_DATA_FLOOR`). The clamp is
 * last so a reversed window is repaired before it is cut, never re-reversed.
 */
function parseProductRange(ctx: any): { start: Date; end: Date } {
  const start = parseDate(ctx.query.start as string);
  const end = parseDate(ctx.query.end as string, 0, "end");
  if (start.getTime() > end.getTime()) {
    return PA.clampToFinancialFloor({ start: end, end: start });
  }
  return PA.clampToFinancialFloor({ start, end });
}

const rowsOf = (res: any): any[] => res?.rows || res?.[0] || [];

/**
 * `YYYY-MM-DD` Tehran dates of a queried window for the response body. An
 * empty window (everything requested fell before the floor) reads as
 * `end < start`, which is the honest shape: nothing was queried.
 */
function effectiveRange(start: Date, end: Date): { start: string; end: string } {
  return { start: PA.tehranYmd(start), end: PA.tehranYmd(end) };
}

/**
 * Which date a money page keys on. Money pages default to the settlement
 * clock (when the cash arrived, as the Payzito ledger counts it); `clock=order`
 * switches to the creation date so a figure can be compared with the order
 * list. See `ReportClock` in the analytics service.
 */
function parseClock(value: unknown, fallback: productAnalytics.ReportClock): productAnalytics.ReportClock {
  return value === "order" || value === "settlement" ? value : fallback;
}

/** Shape one gateway breakdown row (IRR -> Toman) for the API. */
function gatewayRowsFrom(res: any) {
  const rows = rowsOf(res);
  const base = rows.map((r: any) => ({
    gateway: String(r.gateway || "Unknown"),
    label: PA.gatewayLabelFa(r.gateway),
    ordersCount: Number(r.orders_count || 0),
    totalOrdersCount: Number(r.total_orders_count || 0),
    total: Math.round(PA.irrToToman(Number(r.settled_irr || 0))),
  }));
  return {
    gateways: PA.withShares(base, "total"),
    dataQualityWarnings: PA.gatewaySettlementWarnings(base),
    paidOrdersCount: Number(rows[0]?.paid_orders_count || 0),
  };
}

/**
 * Run the period scalar query and shape it into Toman-denominated KPI values.
 *
 * `gross` here is merchandise only — `sales.gross`, the product-line figure every
 * product report is built on. `shipping` is returned ALONGSIDE it, never folded
 * in: a delivery fee belongs to the order, not to any product, so only a
 * store-wide caller (`overview`) may add the two (see `sales.grossWithShipping`).
 */
async function computeProductPeriod(
  knex: any,
  joins: productAnalytics.ResolvedJoins,
  start: Date,
  end: Date,
) {
  const sql = `
    WITH ${PA.paidOrdersCte(joins)}, ${PA.itemizedCte(joins)}
    SELECT
      COALESCE((SELECT SUM(line_gross) FROM itemized), 0)::numeric AS gross,
      COALESCE((SELECT SUM(cnt) FROM itemized), 0)::bigint AS units,
      (SELECT COUNT(*) FROM paid_orders)::bigint AS orders_count,
      COALESCE((SELECT SUM(order_discount) FROM paid_orders), 0)::numeric AS discounts,
      COALESCE((SELECT SUM(refund_irr) FROM paid_orders), 0)::numeric AS refund_irr,
      COALESCE((
        SELECT SUM(o.shipping_cost)
        FROM paid_orders po
        JOIN orders o ON o.id = po.order_id
      ), 0)::numeric AS shipping
  `;
  const res = await knex.raw(sql, [start, end]);
  const row = rowsOf(res)[0] || {};
  const gross = Number(row.gross) || 0;
  const units = Number(row.units) || 0;
  const orders = Number(row.orders_count) || 0;
  const discounts = Number(row.discounts) || 0;
  const refunds = PA.irrToToman(Number(row.refund_irr) || 0);
  // `orders.shipping_cost` is stored in Toman already — never irrToToman it.
  const shipping = Number(row.shipping) || 0;
  const net = gross - discounts - refunds;
  return {
    gross,
    units,
    orders,
    discounts,
    refunds,
    shipping,
    net,
    avgPrice: units > 0 ? gross / units : 0,
    aov: orders > 0 ? gross / orders : 0,
  };
}

/** Attach cover-image URLs to performance rows (one query for the visible page). */
async function attachCoverImages(rows: productAnalytics.ProductPerformanceRow[]) {
  const ids = Array.from(new Set(rows.map((r) => r.productId).filter((id): id is number => !!id)));
  if (ids.length === 0) return rows;
  try {
    const products = (await strapi.entityService.findMany("api::product.product" as any, {
      filters: { id: { $in: ids } },
      fields: ["id"],
      populate: { CoverImage: { fields: ["url"] } },
    })) as any[];
    const imageById = new Map<number, string | null>();
    for (const p of products) imageById.set(p.id, p?.CoverImage?.url ?? null);
    for (const r of rows) {
      if (r.productId) r.imageUrl = imageById.get(r.productId) ?? null;
    }
  } catch (err) {
    strapi.log.warn("attachCoverImages failed", { error: (err as Error).message });
  }
  return rows;
}

const reportController = {
  /**
   * «نقدینگی»: cash collected per Tehran calendar bucket.
   *
   * Reads the SAME `paid_orders` set every other money page uses, keyed on the
   * settlement clock, so its total equals the gateway breakdown for the same
   * window and its series is the payment-clock view of the trends tab.
   * It previously summed every successful transaction in the database
   * (cancelled orders included) and bucketed by UTC day, so a 7-day Tehran
   * window returned 8 buckets and a figure nothing else on the site showed.
   */
  async liquidity(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.finance.read");
      if (!user) return;

      const { start, end } = parseProductRange(ctx);
      const interval = (ctx.query.interval as Interval) || "day";
      const allowed: Interval[] = ["day", "week", "month"];
      const bucket: productAnalytics.Grouping = allowed.includes(interval) ? interval : "day";
      const clock = parseClock(ctx.query.clock, "settlement");

      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);
      const ordersDefinition = await PA.resolvePaidOrdersDefinition(knex, joins, start, end, clock);

      const sql = `
        WITH ${PA.paidOrdersCte(joins, ordersDefinition, clock)}
        SELECT ${PA.tzBucketKeyExpr("order_date", bucket)} AS bucket,
               SUM(settled_irr)::numeric AS total,
               COUNT(*)::bigint AS orders_count
        FROM paid_orders
        GROUP BY 1
        ORDER BY 1
      `;
      const res = await knex.raw(sql, [start, end]);
      const points = rowsOf(res).map((r: any) => ({
        bucket: r.bucket,
        total: Math.round(PA.irrToToman(Number(r.total || 0))),
        orders: Number(r.orders_count || 0),
      }));
      const series = PA.fillBucketSeries(points, start, end, bucket, { total: 0, orders: 0 });

      ctx.body = {
        data: {
          interval: bucket,
          start,
          end,
          currency: "Toman",
          timezone: PA.REPORT_TIMEZONE,
          clock,
          ordersDefinition,
          total: points.reduce((sum, p) => sum + p.total, 0),
          ordersCount: points.reduce((sum, p) => sum + p.orders, 0),
          series,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  async productSales(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.product.read");
      if (!user) return;

      const { start, end } = parseProductRange(ctx);

      const knex = strapi.db.connection;

      // orders <-> order_items link table (must contain both order_id and order_item_id)
      let ordersItemsJoinSql: string | null = null;
      let ordersItemsLink: string | undefined;
      const ordersItemsLinksRes = await knex.raw(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE '%order%item%links%'`,
      );
      const ordersItemsLinks = ordersItemsLinksRes.rows || ordersItemsLinksRes[0] || [];
      for (const row of ordersItemsLinks) {
        const t = String(row.table_name);
        const colsRes = await knex.raw(
          `SELECT column_name FROM information_schema.columns WHERE table_name = ?`,
          [t],
        );
        const cols = new Set(
          (colsRes.rows || colsRes[0] || []).map((r: any) => String(r.column_name)),
        );
        if (cols.has("order_id") && cols.has("order_item_id")) {
          ordersItemsLink = t;
          break;
        }
      }
      if (ordersItemsLink) {
        ordersItemsJoinSql = `
          FROM order_items oi
          JOIN ${ordersItemsLink} l_oi ON l_oi.order_item_id = oi.id
          JOIN orders o ON o.id = l_oi.order_id
        `;
      } else {
        // Fallback to direct FK on order_items (order_id or "order")
        const fkCheck = await knex.raw(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'order_items' AND column_name IN ('order_id','order')`,
        );
        const fkRows = fkCheck.rows || fkCheck[0] || [];
        const fkName = fkRows.find((r: any) => r.column_name === "order_id")
          ? "order_id"
          : fkRows.find((r: any) => r.column_name === "order")
            ? '"order"'
            : "order_id";
        ordersItemsJoinSql = `
          FROM order_items oi
          JOIN orders o ON o.id = oi.${fkName}
        `;
      }

      // order_items <-> product_variations link (optional)
      let productVariationJoinSql = "";
      let selectProductVariationId = "NULL AS product_variation_id";
      const oiPvLinksRes = await knex.raw(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE '%order%item%product%variation%links%'`,
      );
      const oiPvLinks = oiPvLinksRes.rows || oiPvLinksRes[0] || [];
      let oiPvLink: string | undefined;
      for (const row of oiPvLinks) {
        const t = String(row.table_name);
        const colsRes = await knex.raw(
          `SELECT column_name FROM information_schema.columns WHERE table_name = ?`,
          [t],
        );
        const cols = new Set(
          (colsRes.rows || colsRes[0] || []).map((r: any) => String(r.column_name)),
        );
        if (cols.has("order_item_id") && cols.has("product_variation_id")) {
          oiPvLink = t;
          break;
        }
      }
      if (oiPvLink) {
        productVariationJoinSql = `
          LEFT JOIN ${oiPvLink} piv ON piv.order_item_id = oi.id
          LEFT JOIN product_variations pv ON pv.id = piv.product_variation_id
        `;
        selectProductVariationId = "pv.id AS product_variation_id";
      } else {
        // Fallback to direct FK if present
        const hasPvColRes = await knex.raw(
          `SELECT 1 FROM information_schema.columns WHERE table_name = 'order_items' AND column_name = 'product_variation_id'`,
        );
        const hasPvCol = (hasPvColRes.rows || hasPvColRes[0] || []).length > 0;
        if (hasPvCol) {
          selectProductVariationId = "oi.product_variation_id AS product_variation_id";
        }
      }

      const detectJoin = async () => {
        const tryLinkTable = async () => {
          const linkRes = await knex.raw(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name LIKE '%order%contract%links%'`,
          );
          const linkTables = linkRes.rows || linkRes[0] || [];
          for (const row of linkTables) {
            const tableName = String(row.table_name);
            const colsRes = await knex.raw(
              `SELECT column_name FROM information_schema.columns WHERE table_name = ?`,
              [tableName],
            );
            const cols = (colsRes.rows || colsRes[0] || []).map((r: any) => String(r.column_name));
            const orderFk =
              cols.find((c: string) => c === "order_id") ||
              cols.find((c: string) => c.endsWith("order_id")) ||
              cols.find((c: string) => c.startsWith("order") && c.endsWith("_id"));
            const contractFk =
              cols.find((c: string) => c === "contract_id") ||
              cols.find((c: string) => c.endsWith("contract_id")) ||
              cols.find((c: string) => c.startsWith("contract") && c.endsWith("_id"));

            if (orderFk && contractFk) {
              return `
                JOIN ${tableName} col ON col.${orderFk} = o.id
                JOIN contracts c ON c.id = col.${contractFk}
              `;
            }
          }
          return null;
        };

        const tryDirectFk = async () => {
          const contractOrderFkRes = await knex.raw(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'contracts'`,
          );
          const cols = (contractOrderFkRes.rows || contractOrderFkRes[0] || []).map((r: any) =>
            String(r.column_name),
          );
          const orderFkColumn =
            cols.find((c) => c === "order_id") ||
            cols.find((c) => c === "order") ||
            cols.find((c) => c.endsWith("order_id"));
          if (orderFkColumn) {
            return `JOIN contracts c ON c.${orderFkColumn} = o.id`;
          }
          return null;
        };

        const viaLink = await tryLinkTable();
        if (viaLink) {
          return { join: viaLink, source: "link" };
        }
        const viaDirect = await tryDirectFk();
        if (viaDirect) {
          return { join: viaDirect, source: "direct" };
        }
        throw new Error(
          "CONTRACT_RELATION_NOT_FOUND: Unable to resolve order-contract relation for reports",
        );
      };

      const { join: paidOrdersContractJoin, source: contractJoinSource } = await detectJoin();

      const detectContractTxJoin = async () => {
        const contractTxFkRes = await knex.raw(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'contract_transactions'`,
        );
        const contractTxColumns = (contractTxFkRes.rows || contractTxFkRes[0] || []).map((r: any) =>
          String(r.column_name),
        );

        const directFk =
          contractTxColumns.find((c) => c === "contract_id") ||
          contractTxColumns.find((c) => c === "contract") ||
          contractTxColumns.find((c) => c.startsWith("contract") && c.endsWith("_id"));
        if (directFk) {
          return {
            join: `JOIN contract_transactions ct ON ct.${directFk} = c.id`,
            source: "direct",
          };
        }

        const linkRes = await knex.raw(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name LIKE '%contract%transaction%links%'`,
        );
        const linkTables = linkRes.rows || linkRes[0] || [];
        for (const row of linkTables) {
          const tableName = String(row.table_name);
          const colsRes = await knex.raw(
            `SELECT column_name FROM information_schema.columns WHERE table_name = ?`,
            [tableName],
          );
          const cols = (colsRes.rows || colsRes[0] || []).map((r: any) => String(r.column_name));
          const contractFk =
            cols.find((c: string) => c === "contract_id") ||
            cols.find((c: string) => c.endsWith("contract_id")) ||
            cols.find((c: string) => c.startsWith("contract") && c.endsWith("_id"));
          const txFk =
            cols.find((c: string) => c === "contract_transaction_id") ||
            cols.find((c: string) => c.endsWith("contract_transaction_id")) ||
            cols.find((c: string) => c === "transaction_id") ||
            cols.find((c: string) => c.startsWith("contract_transaction") && c.endsWith("_id"));
          if (contractFk && txFk) {
            return {
              join: `
                JOIN ${tableName} lct ON lct.${contractFk} = c.id
                JOIN contract_transactions ct ON ct.id = lct.${txFk}
              `,
              source: "link",
            };
          }
        }

        throw new Error(
          "CONTRACT_TRANSACTION_RELATION_NOT_FOUND: Unable to link contracts to contract_transactions",
        );
      };

      const { join: contractTransactionsJoin, source: contractTransactionsJoinSource } =
        await detectContractTxJoin();

      // Single source of truth for "a paid sale". This used to be a second,
      // divergent inline copy: fewer columns, GROUP BY o.id only, no refund or
      // discount output, and a different revenue formula downstream. Two
      // definitions of the same concept is how gateways quietly go missing from
      // one report but not another.
      const paidOrdersCte = `WITH ${PA.paidOrdersCte({
        orderToContract: paidOrdersContractJoin,
        contractToTx: contractTransactionsJoin,
      } as any)}`;

      const query = `
        ${paidOrdersCte},
        itemized AS (
          SELECT
            ${selectProductVariationId},
            oi.product_title,
            oi.product_sku,
            po.order_date,
            oi.count AS item_count,
            oi.per_amount AS item_unit_amount,
            (oi.per_amount * oi.count)::numeric AS item_total_toman,
            o.id AS order_id,
            po.settled_irr AS settled_amount_irr,
            SUM((oi.per_amount * oi.count)::numeric) OVER (PARTITION BY o.id) AS order_items_subtotal
          ${ordersItemsJoinSql}
          ${productVariationJoinSql}
          JOIN paid_orders po ON po.order_id = o.id
          WHERE o.date BETWEEN ? AND ?
        )
        SELECT
          product_variation_id,
          -- Snapshot columns, so identity is the variation alone (see aggCte).
          -- Grouping by them split a renamed product across two rows.
          (ARRAY_AGG(product_title ORDER BY order_date DESC)
             FILTER (WHERE product_title IS NOT NULL))[1] AS product_title,
          (ARRAY_AGG(product_sku ORDER BY order_date DESC)
             FILTER (WHERE product_sku IS NOT NULL))[1] AS product_sku,
          SUM(item_count)::bigint AS total_count,
          ROUND(
            SUM(
              CASE
                WHEN settled_amount_irr IS NULL
                  OR settled_amount_irr <= 0
                  OR order_items_subtotal IS NULL
                  OR order_items_subtotal <= 0
                THEN item_total_toman
                ELSE (settled_amount_irr / 10.0) * (item_total_toman / order_items_subtotal)
              END
            )
          )::bigint AS total_revenue
        FROM itemized
        GROUP BY product_variation_id,
                 CASE WHEN product_variation_id IS NULL THEN product_sku END
        ORDER BY total_revenue DESC
      `;

      const res = await knex.raw(query, [start, end, start, end]);
      const rows = res.rows || res[0];

      const payload = rows.map((r: any) => ({
        productVariationId: r.product_variation_id,
        productTitle: r.product_title,
        productSKU: r.product_sku,
        totalCount: Number(r.total_count || 0),
        totalRevenue: Number(r.total_revenue || 0),
      }));

      // Optional diagnostics
      const wantsDebug =
        String(ctx.query.debug || "").toLowerCase() === "true" ||
        String(ctx.query.debug || "") === "1";
      if (wantsDebug) {
        // Orders in range
        const [ordersCountRes, joinCountRes, settledMetaRes] = await Promise.all([
          knex.raw(`SELECT COUNT(*)::bigint AS c FROM orders o WHERE o.date BETWEEN ? AND ?`, [
            start,
            end,
          ]),
          knex.raw(
            `SELECT COUNT(*)::bigint AS c ${ordersItemsJoinSql} WHERE o.date BETWEEN ? AND ?`,
            [start, end],
          ),
          knex.raw(
            `${paidOrdersCte}
               SELECT COUNT(*)::bigint AS orders, COALESCE(SUM(settled_irr)::bigint, 0) AS total_amount_irr
               FROM paid_orders`,
            [start, end],
          ),
        ]);

        const ordersCount = Number((ordersCountRes.rows || ordersCountRes[0])[0]?.c || 0);
        const joinCount = Number((joinCountRes.rows || joinCountRes[0])[0]?.c || 0);
        const settledMetaRow = (settledMetaRes.rows || settledMetaRes[0])[0] || {};
        const settledOrders = Number(settledMetaRow.orders || 0);
        const totalSettledIrr = Number(settledMetaRow.total_amount_irr || 0);

        ctx.body = {
          data: payload,
          debug: {
            start,
            end,
            ordersInRange: ordersCount,
            orderItemsJoinedCount: joinCount,
            settledOrders,
            settlementCoverage: ordersCount > 0 ? settledOrders / ordersCount : 0,
            settledAmountToman: totalSettledIrr / 10,
            joinSource: contractJoinSource,
            contractTransactionsJoinSource,
          },
        };
        return;
      }

      ctx.body = { data: payload };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  /**
   * Cash per gateway for the finance workspace. Same query as the products
   * payments tab (`productBreakdown`), so the two can never disagree; kept as
   * its own endpoint because it is gated on `report.finance.read`, not
   * `report.product.read`. It previously grouped by the `payment_gateways` row
   * linked to each transaction — a table with duplicate rows, no Mellat row and
   * 20k unlinked transactions — which is why the pie showed «نامشخص».
   *
   * Also returns `shippingRevenue` over the same `paid_orders` set. The gateway
   * total is cash collected, i.e. merchandise + shipping AFTER discount, on the
   * payment date; the overview's «فروش ناخالص» also carries shipping but is
   * pre-discount and on the order date (decision D16). Without this term the
   * finance page cannot show the merchandise half on its own, and it cannot read
   * the product report's endpoint for it (different capability).
   */
  async gatewayLiquidity(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.finance.read");
      if (!user) return;

      const { start, end } = parseProductRange(ctx);
      const clock = parseClock(ctx.query.clock, "settlement");
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);
      const ordersDefinition = await PA.resolvePaidOrdersDefinition(knex, joins, start, end, clock);
      const [res, shippingRes] = await Promise.all([
        knex.raw(PA.gatewayBreakdownQuery(joins, ordersDefinition, clock), [
          start,
          end,
          start,
          end,
        ]),
        knex.raw(PA.shippingRevenueQuery(joins, ordersDefinition, clock), [start, end]),
      ]);
      const { gateways, dataQualityWarnings, paidOrdersCount } = gatewayRowsFrom(res);
      // Already Toman on the order row; irrToToman would divide it a second time.
      const shippingRevenue = Number(rowsOf(shippingRes)[0]?.shipping_total || 0);

      ctx.body = {
        data: {
          currency: "Toman",
          range: { start, end },
          clock,
          ordersDefinition,
          paidOrdersCount,
          shippingRevenue,
          rows: gateways.map((g) => ({
            gatewayId: null,
            gatewayTitle: g.label,
            ...g,
          })),
          dataQualityWarnings,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  async behaviorOverview(ctx) {
    try {
      if (!(await ensureCapability(ctx, "report.traffic.read"))) return;
      const range = normalizeRange(
        (ctx.query.startDate as string) || (ctx.query.start as string),
        (ctx.query.endDate as string) || (ctx.query.end as string),
      );
      const [payload, analyticsDelivery] = await Promise.all([
        readBehaviorReport("overview", range, behaviorRequestOptions(ctx)),
        getAnalyticsDeliveryHealth(strapi.db.connection),
      ]);
      if (!analyticsDelivery) {
        ctx.body = payload;
        return;
      }
      const data = payload.data
        ? {
            ...(payload.data as any),
            sections: {
              ...((payload.data as any).sections || {}),
              analyticsDelivery,
            },
          }
        : {
            kind: "overview",
            range,
            sections: { analyticsDelivery },
            errors: { source: "UMAMI_UNAVAILABLE" },
          };
      ctx.body = {
        data,
        meta: {
          ...payload.meta,
          status: payload.data ? payload.meta.status : "partial",
          ...(!payload.data
            ? { warnings: ["Umami is unavailable; delivery health remains current."] }
            : {}),
        },
      };
    } catch (error: any) {
      // No special case for INVALID_DATE_RANGE here any more. It used to be
      // rewritten to the English "Invalid date range", which the Persian admin
      // rendered verbatim (presentAnalyticsMessage only recognises tokens with an
      // underscore). Letting the token through means every report endpoint reports
      // a bad range identically and the client owns the wording.
      ctx.badRequest(error?.message || String(error), { data: { success: false } });
    }
  },

  async behaviorAcquisition(ctx) {
    try {
      if (!(await ensureCapability(ctx, "report.traffic.read"))) return;
      const range = normalizeRange(
        (ctx.query.startDate as string) || (ctx.query.start as string),
        (ctx.query.endDate as string) || (ctx.query.end as string),
      );
      ctx.body = await readBehaviorReport("acquisition", range, behaviorRequestOptions(ctx));
    } catch (error: any) {
      ctx.badRequest(error?.message || String(error), { data: { success: false } });
    }
  },

  async behaviorConversion(ctx) {
    try {
      if (!(await ensureCapability(ctx, "report.traffic.read"))) return;
      const range = normalizeRange(
        (ctx.query.startDate as string) || (ctx.query.start as string),
        (ctx.query.endDate as string) || (ctx.query.end as string),
      );
      const options = behaviorRequestOptions(ctx);
      const comparisonRange = options.comparison ? previousRange(range) : null;
      const [payload, commerce, comparisonCommerce] = await Promise.all([
        readBehaviorReport("conversion", range, options),
        getBehaviorCommerce(range),
        comparisonRange ? getBehaviorCommerce(comparisonRange) : Promise.resolve(null),
      ]);
      // Commerce is the authority for successful purchases and revenue. Umami
      // event counts are directional only and never replace this ledger.
      const providerData = payload.data as any;
      const providerComparison = providerData?.comparison as any;
      const comparison = comparisonRange
        ? {
            ...(providerComparison || {
              kind: "conversion",
              range: comparisonRange,
              errors: { source: "UMAMI_UNAVAILABLE" },
            }),
            sections: {
              ...(providerComparison?.sections || {}),
              commerce: comparisonCommerce,
            },
            status: providerComparison?.status || (providerComparison ? "empty" : "partial"),
          }
        : undefined;
      const data = {
        ...(providerData || {
          kind: "conversion",
          range,
          errors: { source: "UMAMI_UNAVAILABLE" },
        }),
        sections: { ...(providerData?.sections || {}), commerce },
        ...(comparisonRange
          ? {
              comparison,
              comparisonStatus: comparison?.status,
            }
          : {}),
      };
      const commerceHasData = Boolean(
        commerce.paidOrders || commerce.totalOrders || commerce.revenueToman,
      );
      const providerStatus = payload.meta.status;
      const status =
        providerStatus === "unavailable"
          ? "partial"
          : providerStatus === "empty" && commerceHasData
            ? "ok"
            : providerStatus;
      ctx.body = {
        data,
        meta: {
          ...payload.meta,
          status,
          ...(providerStatus === "unavailable"
            ? { warnings: ["Umami is unavailable; commerce totals remain current."] }
            : {}),
        },
      };
    } catch (error: any) {
      ctx.badRequest(error?.message || String(error), { data: { success: false } });
    }
  },

  async behaviorContent(ctx) {
    try {
      if (!(await ensureCapability(ctx, "report.traffic.read"))) return;
      const range = normalizeRange(
        (ctx.query.startDate as string) || (ctx.query.start as string),
        (ctx.query.endDate as string) || (ctx.query.end as string),
      );
      ctx.body = await readBehaviorReport("content", range, {
        ...behaviorRequestOptions(ctx, true),
      });
    } catch (error: any) {
      ctx.badRequest(error?.message || String(error), { data: { success: false } });
    }
  },

  async behaviorAudience(ctx) {
    try {
      if (!(await ensureCapability(ctx, "report.traffic.read"))) return;
      const range = normalizeRange(
        (ctx.query.startDate as string) || (ctx.query.start as string),
        (ctx.query.endDate as string) || (ctx.query.end as string),
      );
      ctx.body = await readBehaviorReport("audience", range, {
        ...behaviorRequestOptions(ctx, true),
      });
    } catch (error: any) {
      ctx.badRequest(error?.message || String(error), { data: { success: false } });
    }
  },

  async behaviorPerformance(ctx) {
    try {
      if (!(await ensureCapability(ctx, "report.traffic.read"))) return;
      const range = normalizeRange(
        (ctx.query.startDate as string) || (ctx.query.start as string),
        (ctx.query.endDate as string) || (ctx.query.end as string),
      );
      ctx.body = await readBehaviorReport("performance", range, {
        ...behaviorRequestOptions(ctx, true),
      });
    } catch (error: any) {
      ctx.badRequest(error?.message || String(error), { data: { success: false } });
    }
  },

  async behaviorRealtime(ctx) {
    try {
      if (!(await ensureCapability(ctx, "report.traffic.read"))) return;
      ctx.body = { ...(await readBehaviorRealtime()) };
    } catch (error: any) {
      ctx.badRequest(error?.message || String(error), { data: { success: false } });
    }
  },

  async adminActivity(ctx) {
    try {
      const user = await ensureCapability(ctx, "system.audit.read");
      if (!user) return;

      const start = parseDate(ctx.query.start as string);
      const end = parseDate(ctx.query.end as string, 0, "end");
      const actionType = (ctx.query.action_type as string) || "";
      const logType = (ctx.query.log_type as string) || "All";
      const page = Math.max(Number(ctx.query.page || 1), 1);
      const pageSize = Math.max(Number(ctx.query.pageSize || 20), 1);

      const filters: any = {
        createdAt: {
          $gte: start.toISOString(),
          $lte: end.toISOString(),
        },
      };

      if (logType && logType !== "All") {
        filters.ResourceType = logType;
      }

      if (actionType) {
        filters.Action = actionType;
      }

      if (ctx.query.performedBy) {
        filters.performed_by = { id: Number(ctx.query.performedBy) };
      }

      // Defense-in-depth: although writes are now gated to management roles, keep the role filter
      // so any legacy/non-admin rows are excluded from the report.
      filters.PerformedByRole = { $in: MANAGEMENT_ROLES };

      await applyAdminActivityResourceSearch(filters, ctx);

      const manualActivities = await strapi.entityService.findMany(
        "api::manual-admin-activity.manual-admin-activity" as any,
        {
          filters,
          sort: { createdAt: "desc" },
          populate: ["performed_by"],
          pagination: {
            page,
            pageSize,
          },
        },
      );

      const totalCount = await strapi.entityService.count(
        "api::manual-admin-activity.manual-admin-activity" as any,
        { filters },
      );

      const data = (Array.isArray(manualActivities) ? manualActivities : []).map((log: any) => {
        const actor = log.performed_by;
        return {
          id: log.id,
          ResourceType: log.ResourceType || "Admin",
          Action: log.Action,
          Title: log.Title,
          Message: log.Message,
          MessageEn: log.MessageEn,
          Severity: log.Severity,
          Changes: log.Changes,
          PerformedByName:
            log.PerformedByName ||
            actor?.username ||
            actor?.email ||
            actor?.phone ||
            (actor?.id ? `User ${actor.id}` : "System"),
          PerformedByRole:
            log.PerformedByRole || actor?.role?.name || (actor ? "Unknown" : "System"),
          Description: log.Description,
          Metadata: log.Metadata,
          IP: log.IP,
          UserAgent: log.UserAgent,
          ResourceId: log.ResourceId,
          createdAt: log.createdAt,
          updatedAt: log.updatedAt,
          performed_by: actor,
        };
      });

      // Distinct admins who have activity in the date range, so the frontend admin filter lists
      // every admin (not just those on the current page) and can key options by user id.
      let admins: Array<{ id: number | null; name: string; role: string | null }> = [];
      try {
        const knex = strapi.db.connection;
        const linkTable = "manual_admin_activities_performed_by_links";
        const hasLink = await knex.schema.hasTable(linkTable);
        if (hasLink) {
          const rows = await knex("manual_admin_activities as m")
            .leftJoin(`${linkTable} as l`, "l.manual_admin_activity_id", "m.id")
            .whereBetween("m.created_at", [start.toISOString(), end.toISOString()])
            .whereIn("m.performed_by_role", MANAGEMENT_ROLES)
            .distinct(
              "l.user_id as id",
              "m.performed_by_name as name",
              "m.performed_by_role as role",
            );
          const seen = new Set<string>();
          for (const r of rows as any[]) {
            const key = r.id != null ? `id:${r.id}` : `name:${r.name}`;
            if (!r.id && !r.name) continue;
            if (seen.has(key)) continue;
            seen.add(key);
            admins.push({
              id: r.id ?? null,
              name: r.name || (r.id ? `User ${r.id}` : "نامشخص"),
              role: r.role ?? null,
            });
          }
          admins.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        }
      } catch (adminsError) {
        strapi.log.warn("Failed to load distinct admins for activity report", {
          error: (adminsError as Error).message,
        });
      }

      ctx.body = {
        data,
        meta: {
          pagination: {
            page,
            pageSize,
            total: totalCount,
            pageCount: Math.ceil(totalCount / pageSize) || 1,
          },
          admins,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  async adminActivityById(ctx) {
    try {
      const user = await ensureCapability(ctx, "system.audit.read");
      if (!user) return;

      const id = Number(ctx.params.id);
      if (!id || Number.isNaN(id)) {
        return ctx.badRequest("Invalid id", { data: { success: false } });
      }

      const log = (await strapi.entityService.findOne(
        "api::manual-admin-activity.manual-admin-activity" as any,
        id,
        { populate: ["performed_by"] },
      )) as any;

      if (!log) {
        return ctx.notFound("Activity not found", { data: { success: false } });
      }

      const actor = log.performed_by;
      ctx.body = {
        data: {
          id: log.id,
          ResourceType: log.ResourceType || "Admin",
          Action: log.Action,
          Title: log.Title,
          Message: log.Message,
          MessageEn: log.MessageEn,
          Severity: log.Severity,
          Changes: log.Changes,
          PerformedByName:
            log.PerformedByName ||
            actor?.username ||
            actor?.email ||
            actor?.phone ||
            (actor?.id ? `User ${actor.id}` : "System"),
          PerformedByRole:
            log.PerformedByRole || actor?.role?.name || (actor ? "Unknown" : "System"),
          Description: log.Description,
          Metadata: log.Metadata,
          IP: log.IP,
          UserAgent: log.UserAgent,
          ResourceId: log.ResourceId,
          createdAt: log.createdAt,
          updatedAt: log.updatedAt,
          performed_by: actor,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  // -------------------------------------------------------------------------
  // Product intelligence workspace (server-side aggregation).
  // -------------------------------------------------------------------------

  async productOverview(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.product.read");
      if (!user) return;

      const { start, end } = parseProductRange(ctx);
      // The like-for-like window may reach back past the floor; cut it too.
      const prev = PA.clampToFinancialFloor(PA.previousPeriod(start, end));
      const threshold = PA.DEFAULT_LOW_STOCK_THRESHOLD;
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);

      const [current, previous, invRes] = await Promise.all([
        computeProductPeriod(knex, joins, start, end),
        computeProductPeriod(knex, joins, prev.start, prev.end),
        knex.raw(
          `SELECT
             (SELECT COUNT(*) FROM products p WHERE p.status = 'Active' AND p.removed_at IS NULL)::bigint AS active_products,
             COUNT(*) FILTER (WHERE cnt > ${threshold})::bigint AS in_stock,
             COUNT(*) FILTER (WHERE cnt > 0 AND cnt <= ${threshold})::bigint AS low_stock,
             COUNT(*) FILTER (WHERE cnt <= 0)::bigint AS out_stock,
             COUNT(*)::bigint AS total_variations
           FROM (
             SELECT pv.id, COALESCE(ps.count, 0) AS cnt
             FROM product_variations pv
             ${joins.variationToStock}
           ) sv`,
        ),
      ]);

      const inv = rowsOf(invRes)[0] || {};
      const kpi = (key: keyof typeof current) =>
        PA.periodDelta((current as any)[key], (previous as any)[key]);

      ctx.body = {
        data: {
          range: { start, end },
          previous: { start: prev.start, end: prev.end },
          timezone: PA.REPORT_TIMEZONE,
          lowStockThreshold: threshold,
          kpis: {
            gross: kpi("gross"),
            net: kpi("net"),
            units: kpi("units"),
            orders: kpi("orders"),
            avgPrice: kpi("avgPrice"),
            aov: kpi("aov"),
            discounts: kpi("discounts"),
            refunds: kpi("refunds"),
          },
          inventory: {
            activeProducts: Number(inv.active_products || 0),
            inStock: Number(inv.in_stock || 0),
            lowStock: Number(inv.low_stock || 0),
            outStock: Number(inv.out_stock || 0),
            totalVariations: Number(inv.total_variations || 0),
          },
          notes: {
            currency: "Toman",
            net: "خالص فروش تخمینی است: تخفیف سفارش و مرجوعی به نسبت سهم هر قلم تسهیم می‌شود.",
            refunds: "مرجوعی‌ها در سطح سفارش ثبت می‌شوند و به اقلام تسهیم شده‌اند.",
          },
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  async productBreakdown(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.product.read");
      if (!user) return;

      const { start, end } = parseProductRange(ctx);
      const clock = parseClock(ctx.query.clock, "settlement");
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);
      const ordersDefinition = await PA.resolvePaidOrdersDefinition(knex, joins, start, end, clock);

      const [gatewayRes, shippingRes] = await Promise.all([
        knex.raw(PA.gatewayBreakdownQuery(joins, ordersDefinition, clock), [start, end, start, end]),
        knex.raw(PA.shippingBreakdownQuery(joins, ordersDefinition, clock), [start, end]),
      ]);

      // Cash per gateway (settlement is IRR -> Toman; attach share of total).
      const { gateways, dataQualityWarnings, paidOrdersCount } = gatewayRowsFrom(gatewayRes);

      // Shipping revenue by method (shipping_cost already stored in Toman).
      const shippingMethods = rowsOf(shippingRes).map((r: any) => {
        const raw = String(r.method || "__UNKNOWN__");
        return {
          method: raw === "__UNKNOWN__" ? "نامشخص" : raw,
          ordersCount: Number(r.orders_count || 0),
          total: Number(r.shipping_total || 0),
        };
      });

      const gatewaySales = gateways.reduce((sum, g) => sum + g.total, 0);
      const shippingRevenue = shippingMethods.reduce((sum, s) => sum + s.total, 0);
      // Distinct paid orders: a split payment sits under two gateway rows, so
      // summing the per-row counts would exceed the number of orders.
      const ordersCount = paidOrdersCount;

      ctx.body = {
        data: {
          range: { start, end },
          currency: "Toman",
          clock,
          ordersDefinition,
          totals: { gatewaySales, shippingRevenue, ordersCount },
          gateways,
          shippingMethods,
          dataQualityWarnings,
          notes: {
            gatewaySales:
              "مبلغ دریافتی هر درگاه بر مبنای «سفارش‌های پرداخت‌شده، خالص از مرجوعی» و تاریخ پرداخت است و شامل هزینه ارسال نیز می‌شود؛ سفارش‌های ترکیبی (کیف پول + درگاه) زیر هر دو کانال دیده می‌شوند.",
            shippingRevenue:
              "درآمد ارسال بر مبنای هزینه ارسال ثبت‌شده روی سفارش است (نه فروش محصول).",
          },
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  async productTrends(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.product.read");
      if (!user) return;

      const { start, end } = parseProductRange(ctx);
      const grouping = PA.normalizeGrouping(ctx.query.grouping, start, end);
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);

      const bucketItems = PA.tzBucketKeyExpr("order_date", grouping);
      const bucketOrders = PA.tzBucketKeyExpr("order_date", grouping);
      const ordersDefinition = await PA.resolvePaidOrdersDefinition(knex, joins, start, end);

      const sql = `
        WITH ${PA.paidOrdersCte(joins, ordersDefinition)}, ${PA.itemizedCte(joins)},
        items_b AS (
          SELECT ${bucketItems} AS bucket,
                 SUM(line_gross)::numeric AS gross,
                 SUM(cnt)::bigint AS units
          FROM itemized GROUP BY 1
        ),
        orders_b AS (
          SELECT ${bucketOrders} AS bucket,
                 COUNT(*)::bigint AS orders_count,
                 SUM(order_discount)::numeric AS discounts,
                 SUM(refund_irr)::numeric AS refund_irr
          FROM paid_orders GROUP BY 1
        )
        SELECT
          COALESCE(i.bucket, o.bucket) AS bucket,
          COALESCE(i.gross, 0)::numeric AS gross,
          COALESCE(i.units, 0)::bigint AS units,
          COALESCE(o.orders_count, 0)::bigint AS orders_count,
          COALESCE(o.discounts, 0)::numeric AS discounts,
          COALESCE(o.refund_irr, 0)::numeric AS refund_irr
        FROM items_b i
        FULL OUTER JOIN orders_b o ON i.bucket = o.bucket
        ORDER BY 1
      `;
      const res = await knex.raw(sql, [start, end]);
      const series = PA.fillTrendSeries(
        rowsOf(res).map((r: any) => {
          const gross = Number(r.gross) || 0;
          const discounts = Number(r.discounts) || 0;
          const refunds = PA.irrToToman(Number(r.refund_irr) || 0);
          return {
            bucket: r.bucket,
            gross: Math.round(gross),
            net: Math.round(gross - discounts - refunds),
            units: Number(r.units) || 0,
            orders: Number(r.orders_count) || 0,
            discounts: Math.round(discounts),
            refunds: Math.round(refunds),
          };
        }),
        start,
        end,
        grouping,
      );

      ctx.body = {
        data: {
          range: { start, end },
          grouping,
          timezone: PA.REPORT_TIMEZONE,
          // "settled" counts gateway-settled orders; "completed" counts Done
          // orders because the window has no settlement rows. The UI must say
          // which one produced these numbers.
          ordersDefinition,
          series,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  async productPerformance(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.product.read");
      if (!user) return;

      const { start, end } = parseProductRange(ctx);
      // SuperAdminTable sends pagination[page]; Strapi's qs parser nests it under
      // ctx.query.pagination. Accept the nested form, the bracket-literal, or flat.
      const pag = (ctx.query.pagination as any) || {};
      const page = PA.clampPage(pag.page ?? ctx.query["pagination[page]"] ?? ctx.query.page);
      const pageSize = PA.clampPageSize(
        pag.pageSize ?? ctx.query["pagination[pageSize]"] ?? ctx.query.pageSize,
      );
      const sort = PA.normalizeSort(ctx.query.sort);
      const threshold = PA.DEFAULT_LOW_STOCK_THRESHOLD;
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);

      // WHERE filters on the enriched select (params appended after [start, end]).
      const where: string[] = [];
      const params: any[] = [start, end];
      const q = (ctx.query.q as string)?.trim();
      if (q) {
        where.push("(agg.title_search ILIKE ? OR agg.sku_search ILIKE ?)");
        params.push(`%${q}%`, `%${q}%`);
      }
      const type = ctx.query.productType as string;
      if (type === "Simple" || type === "Variable") {
        where.push("p.product_type = ?");
        params.push(type);
      }
      const categoryId = Number(ctx.query.categoryId);
      if (Number.isFinite(categoryId) && categoryId > 0) {
        // Membership, not the label join. `pc` is only the product's MAIN category —
        // filtering on it hid every product filed under the category through
        // `product_other_categories`, and ignored the category's descendants, so a
        // parent category reported a fraction of its real sales.
        const filter = PA.categoryFilterSql(joins, "p.id");
        if (filter) {
          where.push(filter);
          params.push(categoryId);
        }
      }
      const stockStatus = ctx.query.stockStatus as string;
      if (stockStatus === "out") where.push(`COALESCE(ps.count, 0) <= 0`);
      else if (stockStatus === "low") where.push(`(ps.count > 0 AND ps.count <= ${threshold})`);
      else if (stockStatus === "in") where.push(`ps.count > ${threshold}`);

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      // Only paidOrdersCte declares bindings, so `params` stays [start, end, ...filters].
      const core = `
        WITH ${PA.performanceCtes(joins)}
        ${PA.performanceCoreSelect(joins)}
        ${whereSql}
      `;

      const dataSql = `${core} ORDER BY ${sort.column} ${sort.direction} NULLS LAST LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
      const countSql = `SELECT COUNT(*)::bigint AS total FROM (${core}) sub`;

      const [dataRes, countRes] = await Promise.all([
        knex.raw(dataSql, params),
        knex.raw(countSql, params),
      ]);

      const rows = rowsOf(dataRes).map((r: any) => PA.serializeProductRow(r, threshold));
      await attachCoverImages(rows);
      const total = Number(rowsOf(countRes)[0]?.total || 0);

      ctx.body = {
        data: rows,
        meta: {
          pagination: {
            page,
            pageSize,
            total,
            pageCount: Math.ceil(total / pageSize) || 1,
          },
          range: { start, end },
          sort,
          lowStockThreshold: threshold,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  async productExport(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.product.read");
      if (!user) return;

      const { start, end } = parseProductRange(ctx);
      const sort = PA.normalizeSort(ctx.query.sort);
      const threshold = PA.DEFAULT_LOW_STOCK_THRESHOLD;
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);

      const where: string[] = [];
      const params: any[] = [start, end];
      const q = (ctx.query.q as string)?.trim();
      if (q) {
        where.push("(agg.title_search ILIKE ? OR agg.sku_search ILIKE ?)");
        params.push(`%${q}%`, `%${q}%`);
      }
      const type = ctx.query.productType as string;
      if (type === "Simple" || type === "Variable") {
        where.push("p.product_type = ?");
        params.push(type);
      }
      const categoryId = Number(ctx.query.categoryId);
      if (Number.isFinite(categoryId) && categoryId > 0) {
        // Membership, not the label join. `pc` is only the product's MAIN category —
        // filtering on it hid every product filed under the category through
        // `product_other_categories`, and ignored the category's descendants, so a
        // parent category reported a fraction of its real sales.
        const filter = PA.categoryFilterSql(joins, "p.id");
        if (filter) {
          where.push(filter);
          params.push(categoryId);
        }
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      // Hard cap to protect memory; the visible report is paginated separately.
      const EXPORT_CAP = 10000;
      const sql = `
        WITH ${PA.performanceCtes(joins)}
        ${PA.performanceCoreSelect(joins)}
        ${whereSql}
        ORDER BY ${sort.column} ${sort.direction} NULLS LAST
        LIMIT ${EXPORT_CAP}
      `;
      const res = await knex.raw(sql, params);
      const rows = rowsOf(res).map((r: any) => PA.serializeProductRow(r, threshold));

      // Every row here is ONE VARIATION, so the variant columns are what make two
      // rows of the same product tellable apart, and «موجودی» is that variation's
      // alone. Keep this list index-aligned with `dataRows` below.
      const columns: WorkbookColumn[] = [
        { header: "نام محصول" },
        { header: "SKU" },
        { header: "رنگ" },
        { header: "سایز" },
        { header: "مدل" },
        { header: "سایر ویژگی‌ها" },
        { header: "نوع" },
        { header: "دسته" },
        { header: "تعداد فروش", numeric: true },
        { header: "فروش ناخالص (تومان)", numeric: true },
        { header: "تخفیف (تومان)", numeric: true },
        { header: "مرجوعی (تومان)", numeric: true },
        { header: "خالص فروش (تومان)", numeric: true },
        { header: "سفارش‌ها", numeric: true },
        { header: "قیمت میانگین (تومان)", numeric: true },
        { header: "موجودی متغیر", numeric: true },
        { header: "وضعیت موجودی" },
        { header: "موجودی کل محصول", numeric: true },
        { header: "تعداد متغیرها", numeric: true },
      ];
      const statusFa: Record<string, string> = {
        in: "موجود",
        low: "کم",
        out: "ناموجود",
        unknown: "نامشخص",
      };
      const dataRows = rows.map((r) => [
        r.productTitle,
        r.productSKU,
        r.variantColor ?? "",
        r.variantSize ?? "",
        r.variantModel ?? "",
        r.variantOther ?? "",
        r.productType ?? "",
        r.category ?? "",
        r.units,
        r.gross,
        r.discounts,
        r.refunds,
        r.net,
        r.ordersCount,
        r.avgPrice,
        r.currentStock ?? "",
        statusFa[r.stockStatus] ?? "",
        r.productTotalStock ?? "",
        r.productVariationCount ?? "",
      ]);

      const buffer = await buildStyledWorkbook({
        sheetName: "گزارش محصولات",
        columns,
        rows: dataRows,
      });
      ctx.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      ctx.set("Content-Disposition", `attachment; filename="product-report-${Date.now()}.xlsx"`);
      ctx.body = buffer;
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  async productDetail(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.product.read");
      if (!user) return;

      const productId = Number(ctx.query.productId);
      if (!Number.isFinite(productId) || productId <= 0) {
        return ctx.badRequest("productId is required", { data: { success: false } });
      }
      const { start, end } = parseProductRange(ctx);
      const grouping = PA.normalizeGrouping(ctx.query.grouping, start, end);
      const threshold = PA.DEFAULT_LOW_STOCK_THRESHOLD;
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);

      // Product header + category.
      const infoRes = await knex.raw(
        `SELECT p.id, p.title, p.slug, p.product_type, p.status, ${joins.productToCategory.titleExpr} AS category_title
         FROM products p
         ${joins.productToCategory.join}
         WHERE p.id = ?`,
        [productId],
      );
      const info = rowsOf(infoRes)[0];
      if (!info) {
        return ctx.notFound("Product not found", { data: { success: false } });
      }

      // All variations of the product, with current stock and window sales.
      // The attribute CTE is "all"-scoped here: this list includes variations that
      // never sold, which an `agg`-scoped CTE would leave unlabelled.
      const variationsSql = `
        WITH ${PA.paidOrdersCte(joins)}, ${PA.itemizedCte(joins)}, ${PA.aggCte()},
             ${PA.variationAttributesCte(joins, "all")}
        SELECT
          pv.id AS variation_id,
          pv.sku,
          COALESCE(a.units, 0)::bigint AS units,
          COALESCE(a.gross, 0)::numeric AS gross,
          COALESCE(a.discounts, 0)::numeric AS discounts,
          COALESCE(a.refunds_irr, 0)::numeric AS refunds_irr,
          ps.count AS current_stock,
          ps.reserved_count AS reserved_stock,
          ${PA.variantColumnsSelect(true)}
        FROM product_variations pv
        ${joins.variationToProduct}
        ${joins.variationToStock}
        ${PA.variantJoins("pv.id")}
        LEFT JOIN agg a ON a.product_variation_id = pv.id
        WHERE p.id = ?
        ORDER BY units DESC, pv.id ASC
      `;
      const variationsRes = await knex.raw(variationsSql, [start, end, productId]);
      const variations = rowsOf(variationsRes).map((r: any) => {
        const gross = Number(r.gross) || 0;
        const discounts = Number(r.discounts) || 0;
        const refunds = PA.irrToToman(Number(r.refunds_irr) || 0);
        const stock = r.current_stock === null ? null : Number(r.current_stock) || 0;
        return {
          variationId: r.variation_id,
          sku: r.sku,
          units: Number(r.units) || 0,
          gross: Math.round(gross),
          discounts: Math.round(discounts),
          refunds: Math.round(refunds),
          net: Math.round(gross - discounts - refunds),
          currentStock: stock,
          reservedStock: r.reserved_stock === null ? null : Number(r.reserved_stock) || 0,
          stockStatus: stock === null ? "unknown" : PA.classifyStock(stock, threshold),
          ...PA.serializeVariantIdentity(r),
        };
      });

      // Product-level daily/weekly trend.
      const bucket = PA.tzBucketKeyExpr("order_date", grouping);
      const trendSql = `
        WITH ${PA.paidOrdersCte(joins)}, ${PA.itemizedCte(joins)}
        SELECT ${bucket} AS bucket,
               SUM(it.line_gross)::numeric AS gross,
               SUM(it.cnt)::bigint AS units
        FROM itemized it
        JOIN product_variations pv ON pv.id = it.product_variation_id
        ${joins.variationToProduct}
        WHERE p.id = ?
        GROUP BY 1 ORDER BY 1
      `;
      const trendRes = await knex.raw(trendSql, [start, end, productId]);
      const trend = rowsOf(trendRes).map((r: any) => ({
        bucket: r.bucket,
        gross: Math.round(Number(r.gross) || 0),
        units: Number(r.units) || 0,
      }));

      const totals = variations.reduce(
        (acc, v) => {
          acc.units += v.units;
          acc.gross += v.gross;
          acc.discounts += v.discounts;
          acc.refunds += v.refunds;
          acc.net += v.net;
          if (v.currentStock !== null) acc.currentStock += v.currentStock;
          return acc;
        },
        { units: 0, gross: 0, discounts: 0, refunds: 0, net: 0, currentStock: 0 },
      );

      // Optional Umami behavioral data for this product page. Fully graceful:
      // `null` when Umami is unconfigured/unavailable — never blocks the report.
      const behavioral = hasCapability(user.role, "report.traffic.read")
        ? await getProductBehavioralUmami(String(info.slug || ""), {
            startDate: start.toISOString().slice(0, 10),
            endDate: end.toISOString().slice(0, 10),
          })
        : null;

      ctx.body = {
        data: {
          product: {
            id: info.id,
            title: info.title,
            productType: info.product_type,
            status: info.status,
            category: info.category_title,
          },
          range: { start, end },
          grouping,
          timezone: PA.REPORT_TIMEZONE,
          totals,
          variations,
          trend,
          // Behavioral engagement from Umami (distinct from transactional truth above).
          behavioral,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  async productInventory(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.product.read");
      if (!user) return;

      const { start, end } = parseProductRange(ctx);
      const threshold = PA.DEFAULT_LOW_STOCK_THRESHOLD;
      const days = PA.windowDays(start, end);
      const limit = PA.clampPageSize(ctx.query.limit, 50);
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);

      const sql = `
        WITH ${PA.paidOrdersCte(joins)},
        sales AS (
          SELECT ${joins.oiToVariation.idExpr} AS pvid,
                 SUM(oi.count)::bigint AS units,
                 SUM(oi.per_amount * oi.count)::numeric AS gross
          FROM order_items oi
          ${joins.oiToOrder}
          ${joins.oiToVariation.join}
          JOIN paid_orders po ON po.order_id = o.id
          GROUP BY ${joins.oiToVariation.idExpr}
        ),
        ${PA.variationAttributesCte(joins, "all")}
        SELECT
          pv.id AS variation_id,
          pv.sku,
          p.id AS product_id,
          p.title AS product_title,
          COALESCE(ps.count, 0)::bigint AS current_stock,
          COALESCE(ps.reserved_count, 0)::bigint AS reserved_stock,
          COALESCE(s.units, 0)::bigint AS units_sold,
          COALESCE(s.gross, 0)::numeric AS gross,
          ${PA.variantColumnsSelect()}
        FROM product_variations pv
        ${joins.variationToProduct}
        ${joins.variationToStock}
        ${PA.variantJoins("pv.id")}
        LEFT JOIN sales s ON s.pvid = pv.id
        WHERE p.removed_at IS NULL AND p.status = 'Active'
      `;
      const res = await knex.raw(sql, [start, end]);
      const all = rowsOf(res).map((r: any) => {
        const stock = Number(r.current_stock) || 0;
        const units = Number(r.units_sold) || 0;
        return {
          variationId: r.variation_id,
          productId: r.product_id,
          sku: r.sku,
          productTitle: r.product_title,
          currentStock: stock,
          reservedStock: Number(r.reserved_stock) || 0,
          unitsSold: units,
          gross: Math.round(Number(r.gross) || 0),
          daysOfCover: PA.daysOfCover(stock, units, days),
          stockStatus: PA.classifyStock(stock, threshold),
          ...PA.serializeVariantIdentity(r),
        };
      });

      const outOfStock = all.filter((r) => r.currentStock <= 0).slice(0, limit);
      const lowStock = all
        .filter((r) => r.currentStock > 0 && r.currentStock <= threshold)
        .sort((a, b) => a.currentStock - b.currentStock)
        .slice(0, limit);
      const stockNoSales = all
        .filter((r) => r.currentStock > 0 && r.unitsSold === 0)
        .sort((a, b) => b.currentStock - a.currentStock)
        .slice(0, limit);
      const fastMoving = all
        .filter((r) => r.unitsSold > 0)
        .sort((a, b) => b.unitsSold - a.unitsSold)
        .slice(0, limit);
      const slowMoving = all
        .filter((r) => r.unitsSold > 0 && r.currentStock > 0)
        .sort((a, b) => (b.daysOfCover ?? 0) - (a.daysOfCover ?? 0))
        .slice(0, limit);

      ctx.body = {
        data: {
          range: { start, end },
          windowDays: days,
          lowStockThreshold: threshold,
          timezone: PA.REPORT_TIMEZONE,
          outOfStock,
          lowStock,
          stockNoSales,
          fastMoving,
          slowMoving,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  /**
   * WooReports-parity "sales by X" breakdown. Covers the 5 dimensions that had no
   * existing endpoint (status, category, customer, coupon, geography) — "date",
   * "product"/"variation" and "gateway"/"shipping" are already served by
   * /reports/products/{trends,performance,breakdown} and are NOT duplicated here.
   * See docs/analytics/analytics-progress.md for the full parity table.
   */
  async salesBreakdown(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.sales.read");
      if (!user) return;

      const dimension = ctx.query.dimension as string;
      if (!SALES_BREAKDOWN_DIMENSIONS.includes(dimension as SalesBreakdownDimension)) {
        return ctx.badRequest(
          `Invalid dimension. Expected one of: ${SALES_BREAKDOWN_DIMENSIONS.join(", ")}`,
          { data: { success: false } },
        );
      }

      const { start, end } = parseProductRange(ctx);
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);
      const result = await getSalesBreakdown(
        knex,
        joins,
        dimension as SalesBreakdownDimension,
        start,
        end,
      );

      ctx.body = {
        data: {
          dimension: result.dimension,
          range: { start, end },
          currency: "Toman",
          timezone: PA.REPORT_TIMEZONE,
          definitionVersion: METRIC_CATALOG["sales.net"].definitionVersion,
          source: "commerce",
          refreshedAt: new Date().toISOString(),
          // Truthful, not hardcoded: a degraded category report is partial data and
          // must not be presented as complete.
          partial: result.warnings.length > 0,
          warnings: result.warnings,
          truncated: result.truncated,
          // "settled" counts gateway-settled orders; "completed" counts Done
          // orders because the window has no settlement rows. The UI must say
          // which one produced these numbers.
          ordersDefinition: result.ordersDefinition,
          rows: result.rows,
        },
      };

      for (const warning of result.warnings) {
        strapi?.log?.warn?.(
          `[reports] sales breakdown degraded: ${warning.code} (dimension=${dimension})`,
        );
      }
    } catch (error) {
      // A report that fails must leave a trace on the server. Returning only the
      // message to the client is how a broken reporting query stays invisible.
      strapi?.log?.error?.(
        `[reports] sales breakdown failed (dimension=${ctx.query.dimension}): ${error?.message}`,
      );
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  /** XLSX export of {@link salesBreakdown}, reusing the same styled-workbook builder as productExport. */
  async salesBreakdownExport(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.sales.read");
      if (!user) return;

      const dimension = ctx.query.dimension as string;
      if (!SALES_BREAKDOWN_DIMENSIONS.includes(dimension as SalesBreakdownDimension)) {
        return ctx.badRequest(
          `Invalid dimension. Expected one of: ${SALES_BREAKDOWN_DIMENSIONS.join(", ")}`,
          { data: { success: false } },
        );
      }

      const { start, end } = parseProductRange(ctx);
      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);
      const result = await getSalesBreakdown(
        knex,
        joins,
        dimension as SalesBreakdownDimension,
        start,
        end,
      );

      const keyHeaderFa: Record<SalesBreakdownDimension, string> = {
        status: "وضعیت سفارش",
        category: "دسته‌بندی",
        customer: "مشتری",
        coupon: "کد تخفیف",
        geography: "استان",
      };
      // The category dimension is a tree whose parent rows already CONTAIN their
      // children's totals. A flat sheet of those rows would read as if the amounts
      // were additive, so it gets an indent plus an explicit parent column. Every
      // other dimension keeps the original 7 columns exactly.
      const isTree = dimension === "category";
      const labelByKey = new Map(result.rows.map((r) => [r.key, r.label]));
      const columns: WorkbookColumn[] = [
        { header: keyHeaderFa[dimension as SalesBreakdownDimension] },
        ...(isTree ? [{ header: "دسته والد" } as WorkbookColumn] : []),
        { header: "سفارش‌ها", numeric: true },
        { header: "تعداد", numeric: true },
        { header: "فروش ناخالص (تومان)", numeric: true },
        { header: "تخفیف (تومان)", numeric: true },
        { header: "مرجوعی (تومان)", numeric: true },
        { header: "خالص فروش (تومان)", numeric: true },
      ];
      const dataRows = result.rows.map((r) => [
        isTree ? `${"— ".repeat(r.depth ?? 0)}${r.label}` : r.label,
        ...(isTree ? [(r.parentKey && labelByKey.get(r.parentKey)) || ""] : []),
        r.ordersCount,
        r.units,
        r.grossToman,
        r.discountsToman,
        r.refundsToman,
        r.netToman,
      ]);

      const buffer = await buildStyledWorkbook({
        sheetName: `فروش بر اساس ${keyHeaderFa[dimension as SalesBreakdownDimension]}`,
        columns,
        rows: dataRows,
      });
      ctx.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      ctx.set(
        "Content-Disposition",
        `attachment; filename="sales-${dimension}-${Date.now()}.xlsx"`,
      );
      ctx.body = buffer;
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },

  /**
   * Executive overview: store-wide sales KPIs with prior-period comparison (reusing
   * the SAME `computeProductPeriod`/`paidOrdersCte` every product report already
   * uses — no product filter applied, so this is the whole store). Behavioral
   * reporting remains separately capability-gated and can never delay Finance.
   *
   * This endpoint's «فروش ناخالص» is `sales.grossWithShipping` — merchandise plus
   * the delivery fee — because store-wide it is the amount the orders were written
   * for. The product reports keep the line-only `sales.gross`, so for the same
   * window their «فروش ناخالص» reads lower here by exactly `sales.shipping`
   * (decision D16). «فروش خالص» is merchandise-only in BOTH.
   */
  async overview(ctx) {
    try {
      const user = await ensureCapability(ctx, "report.sales.read");
      if (!user) return;

      const range = normalizeRange(
        (ctx.query.start as string) || (ctx.query.startDate as string),
        (ctx.query.end as string) || (ctx.query.endDate as string),
      );
      const prevRange = previousRange(range);
      const { start, end } = PA.clampToFinancialFloor({
        start: parseDate(range.startDate, 30, "start"),
        end: parseDate(range.endDate, 0, "end"),
      });
      const { start: prevStart, end: prevEnd } = PA.clampToFinancialFloor({
        start: parseDate(prevRange.startDate, 30, "start"),
        end: parseDate(prevRange.endDate, 0, "end"),
      });

      const knex = strapi.db.connection;
      const joins = await PA.resolveJoins(knex);

      const [currentPeriod, previousPeriod, analyticsDelivery] = await Promise.all([
        computeProductPeriod(knex, joins, start, end),
        computeProductPeriod(knex, joins, prevStart, prevEnd),
        getAnalyticsDeliveryHealth(knex),
      ]);

      // Store-wide «فروش ناخالص» is what the orders were written for: merchandise
      // lines PLUS the delivery fee. `orders.shipping_cost` is the only other money
      // the customer is charged — tax is disabled store-wide (cart computeTotals) and
      // ShippingTax/ShippingPostPrice are carrier-side metadata, not charges.
      // «فروش خالص» stays merchandise-only, so shipping leaves again as a subtracted
      // term of this page's identity rather than flowing into net. Both periods are
      // composed BEFORE periodDelta so the comparison is like-for-like.
      // `avgPrice`/`aov` are dropped rather than recomputed: this page shows
      // neither, and keeping merchandise-only averages next to a shipping-inclusive
      // gross is exactly the trap this endpoint exists to avoid.
      const withShipping = ({
        avgPrice: _avgPrice,
        aov: _aov,
        ...period
      }: Awaited<ReturnType<typeof computeProductPeriod>>) => ({
        ...period,
        gross: period.gross + period.shipping,
      });
      const current = withShipping(currentPeriod);
      const previous = withShipping(previousPeriod);

      const kpi = (key: keyof typeof current) =>
        PA.periodDelta((current as any)[key], (previous as any)[key]);

      ctx.body = {
        data: {
          // Echo the window that was actually queried, not the one requested,
          // so a client can see where the floor cut it.
          range: effectiveRange(start, end),
          previous: effectiveRange(prevStart, prevEnd),
          timezone: PA.REPORT_TIMEZONE,
          currency: "Toman",
          // The headline figure of THIS page is the shipping-inclusive gross, so it
          // is that metric's version that a consumer must key on. `sales.net` is
          // unchanged and still versions the breakdown endpoint.
          definitionVersion: METRIC_CATALOG["sales.grossWithShipping"].definitionVersion,
          sales: {
            gross: kpi("gross"),
            net: kpi("net"),
            units: kpi("units"),
            orders: kpi("orders"),
            discounts: kpi("discounts"),
            refunds: kpi("refunds"),
            shipping: kpi("shipping"),
          },
          analyticsDelivery,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message, { data: { success: false } });
    }
  },
};

// Keep the previous controller action identifiers registered for one-way role
// migration and rollback snapshot compatibility. Compatibility URLs route to
// the canonical behavior actions, and the role template grants only those new
// actions, so a successful synchronization removes these legacy permissions.
export default {
  ...reportController,
  trafficDashboard: reportController.behaviorOverview,
  trafficRealtime: reportController.behaviorRealtime,
  funnel: reportController.behaviorConversion,
};
