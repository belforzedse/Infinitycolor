/**
 * Sales-breakdown semantic queries: the five WooReports parity dimensions that
 * had no existing endpoint (status, category, customer, coupon, geography).
 *
 * "date", "product", "variation" and "gateway"/"shipping" are already covered by
 * `/reports/products/trends`, `/reports/products/performance` and
 * `/reports/products/breakdown` respectively — those are reused as-is by the admin
 * UI rather than duplicated here. See docs/analytics/analytics-progress.md for the
 * full parity table.
 *
 * Every query composes the SAME `paidOrdersCte`/`itemizedCte` used by
 * product-analytics.ts, so a dimension here can never disagree with an existing
 * report about which orders count as "eligible" (see catalog.ts `sales.eligibleOrders`).
 *
 * Rows that don't resolve to a known bucket (guest customers, orders with no
 * delivery address / unmapped city) are surfaced as an explicit bucket, never
 * silently dropped — see analytics-decisions.md.
 */

import * as PA from "../../services/product-analytics";

type Knex = any;

const rowsOf = (res: any): any[] => res?.rows ?? res?.[0] ?? [];

export type SalesBreakdownDimension = "status" | "category" | "customer" | "coupon" | "geography";

export interface SalesBreakdownRow {
  key: string;
  label: string;
  ordersCount: number;
  units: number;
  grossToman: number;
  discountsToman: number;
  refundsToman: number;
  netToman: number;
}

export interface SalesBreakdownResult {
  dimension: SalesBreakdownDimension;
  rows: SalesBreakdownRow[];
  truncated: boolean;
}

const MAX_BREAKDOWN_ROWS = 200;

const ORDER_STATUS_LABELS_FA: Record<string, string> = {
  Paying: "در حال پرداخت",
  Started: "شروع‌شده",
  Shipment: "ارسال‌شده",
  Done: "تکمیل‌شده",
  Returned: "مرجوع‌شده",
  Cancelled: "لغوشده",
};

function toRow(raw: {
  key: string;
  label: string;
  ordersCount: number;
  units?: number;
  gross: number;
  discounts: number;
  refundIrr: number;
}): SalesBreakdownRow {
  const gross = Math.round(raw.gross);
  const discounts = Math.round(raw.discounts);
  const refunds = Math.round(PA.irrToToman(raw.refundIrr));
  return {
    key: raw.key,
    label: raw.label,
    ordersCount: raw.ordersCount,
    units: raw.units ?? 0,
    grossToman: gross,
    discountsToman: discounts,
    refundsToman: refunds,
    netToman: gross - discounts - refunds,
  };
}

/** Sorts by net descending and collapses any overflow past MAX_BREAKDOWN_ROWS into a synthetic "other" row. */
function finalizeRows(
  rows: SalesBreakdownRow[],
  otherLabel: string,
): { rows: SalesBreakdownRow[]; truncated: boolean } {
  const sorted = [...rows].sort((a, b) => b.netToman - a.netToman);
  if (sorted.length <= MAX_BREAKDOWN_ROWS) return { rows: sorted, truncated: false };

  const kept = sorted.slice(0, MAX_BREAKDOWN_ROWS - 1);
  const overflow = sorted.slice(MAX_BREAKDOWN_ROWS - 1);
  const other = overflow.reduce<SalesBreakdownRow>(
    (acc, r) => ({
      key: "__other__",
      label: otherLabel,
      ordersCount: acc.ordersCount + r.ordersCount,
      units: acc.units + r.units,
      grossToman: acc.grossToman + r.grossToman,
      discountsToman: acc.discountsToman + r.discountsToman,
      refundsToman: acc.refundsToman + r.refundsToman,
      netToman: acc.netToman + r.netToman,
    }),
    { key: "__other__", label: otherLabel, ordersCount: 0, units: 0, grossToman: 0, discountsToman: 0, refundsToman: 0, netToman: 0 },
  );
  return { rows: [...kept, other], truncated: true };
}

/** All orders in range, grouped by `orders.Status` (not gated on settlement — every order gets a row). */
async function getSalesByStatus(
  knex: Knex,
  joins: PA.ResolvedJoins,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  const sql = `
    WITH ${PA.paidOrdersCte(joins)}, ${PA.itemizedCte(joins)},
    item_totals AS (
      SELECT order_id, SUM(line_gross)::numeric AS gross, SUM(cnt)::bigint AS units
      FROM itemized GROUP BY order_id
    )
    SELECT
      o.status AS status,
      COUNT(*)::bigint AS orders_count,
      COALESCE(SUM(it.units), 0)::bigint AS units,
      COALESCE(SUM(it.gross), 0)::numeric AS gross,
      COALESCE(SUM(po.order_discount), 0)::numeric AS discounts,
      COALESCE(SUM(po.refund_irr), 0)::numeric AS refund_irr
    FROM orders o
    LEFT JOIN paid_orders po ON po.order_id = o.id
    LEFT JOIN item_totals it ON it.order_id = o.id
    WHERE o.date BETWEEN ? AND ?
    GROUP BY o.status
  `;
  const res = await knex.raw(sql, [start, end, start, end]);
  const rows = rowsOf(res).map((r: any) =>
    toRow({
      key: String(r.status ?? ""),
      label: ORDER_STATUS_LABELS_FA[String(r.status ?? "")] ?? String(r.status ?? "نامشخص"),
      ordersCount: Number(r.orders_count) || 0,
      units: Number(r.units) || 0,
      gross: Number(r.gross) || 0,
      discounts: Number(r.discounts) || 0,
      refundIrr: Number(r.refund_irr) || 0,
    }),
  );
  const { rows: finalRows, truncated } = finalizeRows(rows, "سایر وضعیت‌ها");
  return { dimension: "status", rows: finalRows, truncated };
}

/** Eligible-order line items grouped by the product's main category. */
async function getSalesByCategory(
  knex: Knex,
  joins: PA.ResolvedJoins,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  const variationToProductLeft = PA.leftify(joins.variationToProduct);
  const hasCategory = Boolean(joins.productToCategory.join);
  const categoryIdExpr = hasCategory ? "pc.id" : "NULL::int";
  const sql = `
    WITH ${PA.paidOrdersCte(joins)}, ${PA.itemizedCte(joins)}
    SELECT
      ${categoryIdExpr} AS category_id,
      ${joins.productToCategory.titleExpr} AS category_title,
      SUM(cnt)::bigint AS units,
      SUM(line_gross)::numeric AS gross,
      SUM(CASE WHEN order_gross > 0 THEN order_discount * line_gross / order_gross ELSE 0 END)::numeric AS discounts,
      SUM(CASE WHEN order_gross > 0 THEN refund_irr * line_gross / order_gross ELSE 0 END)::numeric AS refund_irr,
      COUNT(DISTINCT order_id)::bigint AS orders_count
    FROM itemized
    LEFT JOIN product_variations pv ON pv.id = itemized.product_variation_id
    ${variationToProductLeft}
    ${joins.productToCategory.join}
    GROUP BY 1, 2
  `;
  const res = await knex.raw(sql, [start, end]);
  const rows = rowsOf(res).map((r: any) => {
    const id = r.category_id === null || r.category_id === undefined ? "" : String(r.category_id);
    return toRow({
      key: id,
      label: r.category_title ? String(r.category_title) : "بدون دسته‌بندی",
      ordersCount: Number(r.orders_count) || 0,
      units: Number(r.units) || 0,
      gross: Number(r.gross) || 0,
      discounts: Number(r.discounts) || 0,
      refundIrr: Number(r.refund_irr) || 0,
    });
  });
  const { rows: finalRows, truncated } = finalizeRows(rows, "سایر دسته‌بندی‌ها");
  return { dimension: "category", rows: finalRows, truncated };
}

/** Eligible orders grouped by customer (guest / unresolved users get an explicit bucket). */
async function getSalesByCustomer(
  knex: Knex,
  joins: PA.ResolvedJoins,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  if (!joins.orderToUser) {
    return { dimension: "customer", rows: [], truncated: false };
  }
  const sql = `
    WITH ${PA.paidOrdersCte(joins)}, ${PA.itemizedCte(joins)},
    item_totals AS (
      SELECT order_id, SUM(line_gross)::numeric AS gross, SUM(cnt)::bigint AS units
      FROM itemized GROUP BY order_id
    )
    SELECT
      COALESCE(u.id, 0) AS user_id,
      MAX(NULLIF(TRIM(CONCAT(COALESCE(ui.first_name, ''), ' ', COALESCE(ui.last_name, ''))), '')) AS display_name,
      MAX(u.phone) AS phone,
      COUNT(*)::bigint AS orders_count,
      COALESCE(SUM(it.units), 0)::bigint AS units,
      COALESCE(SUM(it.gross), 0)::numeric AS gross,
      COALESCE(SUM(po.order_discount), 0)::numeric AS discounts,
      COALESCE(SUM(po.refund_irr), 0)::numeric AS refund_irr
    FROM paid_orders po
    JOIN orders o ON o.id = po.order_id
    ${joins.orderToUser}
    ${joins.userToInfo}
    LEFT JOIN item_totals it ON it.order_id = po.order_id
    GROUP BY COALESCE(u.id, 0)
  `;
  const res = await knex.raw(sql, [start, end]);
  const rows = rowsOf(res).map((r: any) => {
    const userId = Number(r.user_id) || 0;
    const label = userId === 0 ? "مهمان" : String(r.display_name || r.phone || `کاربر #${userId}`);
    return toRow({
      key: String(userId),
      label,
      ordersCount: Number(r.orders_count) || 0,
      units: Number(r.units) || 0,
      gross: Number(r.gross) || 0,
      discounts: Number(r.discounts) || 0,
      refundIrr: Number(r.refund_irr) || 0,
    });
  });
  const { rows: finalRows, truncated } = finalizeRows(rows, "سایر مشتریان");
  return { dimension: "customer", rows: finalRows, truncated };
}

/** Eligible orders grouped by `orders.DiscountCode` ('' bucketed as "no coupon used"). */
async function getSalesByCoupon(
  knex: Knex,
  joins: PA.ResolvedJoins,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  const sql = `
    WITH ${PA.paidOrdersCte(joins)}, ${PA.itemizedCte(joins)},
    item_totals AS (
      SELECT order_id, SUM(line_gross)::numeric AS gross, SUM(cnt)::bigint AS units
      FROM itemized GROUP BY order_id
    )
    SELECT
      COALESCE(NULLIF(o.discount_code, ''), '') AS coupon_code,
      COUNT(*)::bigint AS orders_count,
      COALESCE(SUM(it.units), 0)::bigint AS units,
      COALESCE(SUM(it.gross), 0)::numeric AS gross,
      COALESCE(SUM(po.order_discount), 0)::numeric AS discounts,
      COALESCE(SUM(po.refund_irr), 0)::numeric AS refund_irr
    FROM paid_orders po
    JOIN orders o ON o.id = po.order_id
    LEFT JOIN item_totals it ON it.order_id = po.order_id
    GROUP BY 1
  `;
  const res = await knex.raw(sql, [start, end]);
  const rows = rowsOf(res).map((r: any) => {
    const code = String(r.coupon_code ?? "");
    return toRow({
      key: code,
      label: code || "بدون کد تخفیف",
      ordersCount: Number(r.orders_count) || 0,
      units: Number(r.units) || 0,
      gross: Number(r.gross) || 0,
      discounts: Number(r.discounts) || 0,
      refundIrr: Number(r.refund_irr) || 0,
    });
  });
  const { rows: finalRows, truncated } = finalizeRows(rows, "سایر کدهای تخفیف");
  return { dimension: "coupon", rows: finalRows, truncated };
}

/**
 * Eligible orders grouped by delivery-address province. `orders.delivery_address ->
 * local_user_addresses.shipping_city -> shipping_cities.shipping_province` is an
 * UNVERIFIED-until-now join chain (see docs/analytics/analytics-decisions.md) — orders
 * with no address, or an address whose city/province can't be resolved, fall into an
 * explicit "نامشخص" (unmapped) bucket rather than being silently dropped.
 */
async function getSalesByGeography(
  knex: Knex,
  joins: PA.ResolvedJoins,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  if (!joins.orderToAddress || !joins.addressToCity || !joins.cityToProvince) {
    return { dimension: "geography", rows: [], truncated: false };
  }
  const sql = `
    WITH ${PA.paidOrdersCte(joins)}, ${PA.itemizedCte(joins)},
    item_totals AS (
      SELECT order_id, SUM(line_gross)::numeric AS gross, SUM(cnt)::bigint AS units
      FROM itemized GROUP BY order_id
    )
    SELECT
      COALESCE(sp.title, '') AS province_title,
      COUNT(*)::bigint AS orders_count,
      COALESCE(SUM(it.units), 0)::bigint AS units,
      COALESCE(SUM(it.gross), 0)::numeric AS gross,
      COALESCE(SUM(po.order_discount), 0)::numeric AS discounts,
      COALESCE(SUM(po.refund_irr), 0)::numeric AS refund_irr
    FROM paid_orders po
    JOIN orders o ON o.id = po.order_id
    ${joins.orderToAddress}
    ${joins.addressToCity}
    ${joins.cityToProvince}
    LEFT JOIN item_totals it ON it.order_id = po.order_id
    GROUP BY 1
  `;
  const res = await knex.raw(sql, [start, end]);
  const rows = rowsOf(res).map((r: any) => {
    const title = String(r.province_title ?? "");
    return toRow({
      key: title,
      label: title || "نامشخص",
      ordersCount: Number(r.orders_count) || 0,
      units: Number(r.units) || 0,
      gross: Number(r.gross) || 0,
      discounts: Number(r.discounts) || 0,
      refundIrr: Number(r.refund_irr) || 0,
    });
  });
  const { rows: finalRows, truncated } = finalizeRows(rows, "سایر استان‌ها");
  return { dimension: "geography", rows: finalRows, truncated };
}

export async function getSalesBreakdown(
  knex: Knex,
  joins: PA.ResolvedJoins,
  dimension: SalesBreakdownDimension,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  switch (dimension) {
    case "status":
      return getSalesByStatus(knex, joins, start, end);
    case "category":
      return getSalesByCategory(knex, joins, start, end);
    case "customer":
      return getSalesByCustomer(knex, joins, start, end);
    case "coupon":
      return getSalesByCoupon(knex, joins, start, end);
    case "geography":
      return getSalesByGeography(knex, joins, start, end);
    default:
      throw new Error(`UNKNOWN_DIMENSION: ${dimension}`);
  }
}

export const SALES_BREAKDOWN_DIMENSIONS: SalesBreakdownDimension[] = [
  "status",
  "category",
  "customer",
  "coupon",
  "geography",
];
