/**
 * Commerce source adapter for the analytics rollups.
 *
 * Thin layer over `services/product-analytics.ts` — it does not redefine "eligible
 * order" or re-probe schema; it reuses `resolveJoins`, `paidOrdersCte`, `itemizedCte`
 * exactly as the existing /reports/products/* endpoints do, so a rollup and a live
 * report can never silently disagree about which orders count.
 *
 * `getEligibleOrderStats` is NEW code for NEW consumers (Phase 3/4 endpoints and the
 * rollup below) — it is deliberately NOT wired into the existing
 * `/reports/traffic/dashboard` endpoint, whose `getOrderStats` counts orders by
 * `PAID_ORDER_STATUSES` alone (no settlement gate) because «سفارش پرداخت‌شده» asks
 * "did a visit turn into a payment", not "did we sell it" — see D14/D15. Since D15
 * the two status lists match, so the remaining difference is the settlement gate; the
 * constants stay separate because the questions are. See metrics/catalog.ts
 * `sales.eligibleOrders` limitations for why that difference is documented rather
 * than silently fixed.
 */

import * as PA from "../../services/product-analytics";

type Knex = any;

const rowsOf = (res: any): any[] => res?.rows ?? res?.[0] ?? [];

export interface EligibleOrderStats {
  totalOrders: number;
  eligibleOrders: number;
}

/**
 * Canonical eligible-order count for a window, using the SAME definition as
 * product-analytics.ts's `paidOrdersCte` (net-positive successful settlement).
 * Bindings: [start, end, start, end].
 */
export async function getEligibleOrderStats(
  knex: Knex,
  joins: PA.ResolvedJoins,
  start: Date,
  end: Date,
): Promise<EligibleOrderStats> {
  const sql = `
    WITH ${PA.paidOrdersCte(joins)}
    SELECT
      (SELECT COUNT(*) FROM orders WHERE date BETWEEN ? AND ?)::bigint AS total_orders,
      (SELECT COUNT(*) FROM paid_orders)::bigint AS eligible_orders
  `;
  const res = await knex.raw(sql, [start, end, start, end]);
  const row = rowsOf(res)[0] ?? {};
  return {
    totalOrders: Number(row.total_orders ?? 0),
    eligibleOrders: Number(row.eligible_orders ?? 0),
  };
}

export interface DailySalesRollupRow {
  bucketDate: string; // YYYY-MM-DD, Tehran-local
  grossToman: number;
  discountsToman: number;
  refundsToman: number;
  netToman: number;
  units: number;
  eligibleOrders: number;
  totalOrders: number;
}

/**
 * One row per Tehran-local calendar day in [start, end] that had at least one order
 * (eligible or not). Days with zero orders produce no row — a report reading this
 * table for a chart is expected to zero-fill missing days itself (generate_series),
 * which keeps this query bounded to actual activity instead of the full calendar.
 *
 * Bindings: [start, end, start, end] (paid_orders window, then daily_all_orders window).
 */
export async function getDailySalesRollupRows(
  knex: Knex,
  joins: PA.ResolvedJoins,
  start: Date,
  end: Date,
): Promise<DailySalesRollupRow[]> {
  const bucketExpr = PA.tzBucketExpr("order_date", "day");
  const allOrdersBucketExpr = PA.tzBucketExpr("o.date", "day");
  const sql = `
    WITH ${PA.paidOrdersCte(joins)},
    ${PA.itemizedCte(joins)},
    daily_orders AS (
      SELECT
        ${bucketExpr}::date AS bucket_date,
        COUNT(*)::bigint AS eligible_orders,
        COALESCE(SUM(order_discount), 0)::numeric AS discounts,
        COALESCE(SUM(refund_irr), 0)::numeric AS refund_irr
      FROM paid_orders
      GROUP BY 1
    ),
    daily_items AS (
      SELECT
        ${bucketExpr}::date AS bucket_date,
        COALESCE(SUM(line_gross), 0)::numeric AS gross,
        COALESCE(SUM(cnt), 0)::bigint AS units
      FROM itemized
      GROUP BY 1
    ),
    daily_all_orders AS (
      SELECT
        ${allOrdersBucketExpr}::date AS bucket_date,
        COUNT(*)::bigint AS total_orders
      FROM orders o
      WHERE o.date BETWEEN ? AND ?
      GROUP BY 1
    )
    SELECT
      daily_all_orders.bucket_date,
      COALESCE(daily_items.gross, 0) AS gross,
      COALESCE(daily_items.units, 0) AS units,
      COALESCE(daily_orders.eligible_orders, 0) AS eligible_orders,
      COALESCE(daily_orders.discounts, 0) AS discounts,
      COALESCE(daily_orders.refund_irr, 0) AS refund_irr,
      daily_all_orders.total_orders
    FROM daily_all_orders
    LEFT JOIN daily_orders ON daily_orders.bucket_date = daily_all_orders.bucket_date
    LEFT JOIN daily_items ON daily_items.bucket_date = daily_all_orders.bucket_date
    ORDER BY 1
  `;
  const res = await knex.raw(sql, [start, end, start, end]);
  return rowsOf(res).map((row: any) => {
    const gross = Number(row.gross) || 0;
    const discounts = Number(row.discounts) || 0;
    const refunds = PA.irrToToman(Number(row.refund_irr) || 0);
    return {
      bucketDate: toDateOnly(row.bucket_date),
      grossToman: Math.round(gross),
      discountsToman: Math.round(discounts),
      refundsToman: Math.round(refunds),
      netToman: Math.round(gross - discounts - refunds),
      units: Number(row.units) || 0,
      eligibleOrders: Number(row.eligible_orders) || 0,
      totalOrders: Number(row.total_orders) || 0,
    };
  });
}

export interface ProductDailyRollupRow {
  bucketDate: string;
  productVariationId: number; // 0 sentinel for a deleted/unresolved variation
  productSku: string;
  productTitle: string;
  units: number;
  grossToman: number;
  discountsToman: number;
  refundsToman: number;
  ordersCount: number;
}

/**
 * One row per (Tehran-local day, variation) with at least one unit sold; the SKU
 * snapshot only splits rows that have no variation. `product_variation_id = 0` is
 * the deleted-variation sentinel — see the migration docstring for why NULL is
 * avoided in this column. The reported sku/title come from the most recent line, so
 * an import renaming a product does not fragment its history. Bindings: [start, end].
 */
export async function getProductDailyRollupRows(
  knex: Knex,
  joins: PA.ResolvedJoins,
  start: Date,
  end: Date,
): Promise<ProductDailyRollupRow[]> {
  const bucketExpr = PA.tzBucketExpr("order_date", "day");
  const sql = `
    WITH ${PA.paidOrdersCte(joins)},
    ${PA.itemizedCte(joins)}
    SELECT
      ${bucketExpr}::date AS bucket_date,
      COALESCE(product_variation_id, 0) AS product_variation_id,
      COALESCE((ARRAY_AGG(product_sku ORDER BY order_date DESC)
                  FILTER (WHERE product_sku IS NOT NULL))[1], '') AS product_sku,
      (ARRAY_AGG(product_title ORDER BY order_date DESC)
         FILTER (WHERE product_title IS NOT NULL))[1] AS product_title,
      SUM(cnt)::bigint AS units,
      SUM(line_gross)::numeric AS gross,
      SUM(CASE WHEN order_gross > 0 THEN order_discount * line_gross / order_gross ELSE 0 END)::numeric AS discounts,
      SUM(CASE WHEN order_gross > 0 THEN refund_irr * line_gross / order_gross ELSE 0 END)::numeric AS refund_irr,
      COUNT(DISTINCT order_id)::bigint AS orders_count
    FROM itemized
    GROUP BY 1, COALESCE(product_variation_id, 0),
             CASE WHEN product_variation_id IS NULL THEN COALESCE(product_sku, '') END
    ORDER BY 1
  `;
  const res = await knex.raw(sql, [start, end]);
  return rowsOf(res).map((row: any) => {
    const gross = Number(row.gross) || 0;
    const discounts = Number(row.discounts) || 0;
    const refunds = PA.irrToToman(Number(row.refund_irr) || 0);
    return {
      bucketDate: toDateOnly(row.bucket_date),
      productVariationId: Number(row.product_variation_id) || 0,
      productSku: String(row.product_sku ?? ""),
      productTitle: String(row.product_title ?? ""),
      units: Number(row.units) || 0,
      grossToman: Math.round(gross),
      discountsToman: Math.round(discounts),
      refundsToman: Math.round(refunds),
      ordersCount: Number(row.orders_count) || 0,
    };
  });
}

/** Idempotent upsert: re-running the same window overwrites, never duplicates. */
export async function upsertDailySalesRows(knex: Knex, rows: DailySalesRollupRow[]): Promise<void> {
  for (const row of rows) {
    await knex.raw(
      `
      INSERT INTO analytics_daily_sales
        (bucket_date, currency, gross_toman, discounts_toman, refunds_toman, net_toman, units, eligible_orders, total_orders, computed_at)
      VALUES (?, 'Toman', ?, ?, ?, ?, ?, ?, ?, now())
      ON CONFLICT (bucket_date) DO UPDATE SET
        gross_toman = EXCLUDED.gross_toman,
        discounts_toman = EXCLUDED.discounts_toman,
        refunds_toman = EXCLUDED.refunds_toman,
        net_toman = EXCLUDED.net_toman,
        units = EXCLUDED.units,
        eligible_orders = EXCLUDED.eligible_orders,
        total_orders = EXCLUDED.total_orders,
        computed_at = now()
      `,
      [
        row.bucketDate,
        row.grossToman,
        row.discountsToman,
        row.refundsToman,
        row.netToman,
        row.units,
        row.eligibleOrders,
        row.totalOrders,
      ],
    );
  }
}

export async function upsertProductDailyRows(knex: Knex, rows: ProductDailyRollupRow[]): Promise<void> {
  for (const row of rows) {
    await knex.raw(
      `
      INSERT INTO analytics_product_daily
        (bucket_date, product_variation_id, product_sku, product_title, units, gross_toman, discounts_toman, refunds_toman, orders_count, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
      ON CONFLICT (bucket_date, product_variation_id, product_sku) DO UPDATE SET
        product_title = EXCLUDED.product_title,
        units = EXCLUDED.units,
        gross_toman = EXCLUDED.gross_toman,
        discounts_toman = EXCLUDED.discounts_toman,
        refunds_toman = EXCLUDED.refunds_toman,
        orders_count = EXCLUDED.orders_count,
        computed_at = now()
      `,
      [
        row.bucketDate,
        row.productVariationId,
        row.productSku,
        row.productTitle,
        row.units,
        row.grossToman,
        row.discountsToman,
        row.refundsToman,
        row.ordersCount,
      ],
    );
  }
}

function toDateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value ?? "");
  return str.slice(0, 10);
}
