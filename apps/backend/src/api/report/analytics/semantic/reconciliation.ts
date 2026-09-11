/**
 * Canonical, deliberately naive category-sales query — the oracle the reporting
 * layer is checked against.
 *
 * This exists because the reporting query is fast rather than obvious: it walks a
 * recursive ancestry CTE, de-duplicates line/category pairs, and pro-rates
 * order-level money down to line level. A bug in any of that produces a plausible
 * number, which is exactly how category revenue could be under-reported by a third
 * for months without anyone noticing.
 *
 * So this module re-derives the same figures the slow, obvious way: plain `EXISTS`
 * membership tests against the raw link tables, no CTE reuse, no shared fragments
 * with the code under test. If the two disagree, the reporting query is wrong.
 *
 * Deliberately NOT wired into any request path — it re-scans order items for the
 * window on every call. It is for integration tests (see salesBreakdown.int.spec.ts)
 * and for operators reconciling a suspicious report by hand.
 */
import * as PA from "../../services/product-analytics";

type Knex = any;

const rowsOf = (res: any): any[] => res?.rows ?? res?.[0] ?? [];

export interface CanonicalCategorySales {
  ordersCount: number;
  units: number;
  grossToman: number;
  discountsToman: number;
  refundsToman: number;
  netToman: number;
}

export interface CanonicalCategoryOptions {
  /**
   * `true` (default) counts the category together with every descendant, matching
   * the storefront category page. `false` counts only products filed directly under
   * this exact category.
   */
  includeDescendants?: boolean;
  /** Defaults to the same eligibility rule the reports use. */
  definition?: PA.PaidOrdersDefinition;
}

/**
 * Gross/units/orders/discounts/refunds/net for one category over one window,
 * computed from the raw link tables.
 *
 * `orders.Status` gating and the settlement rule are shared with the report on
 * purpose — this oracle is for the CATEGORY and MONEY logic, not for re-litigating
 * which orders count (that is `sales.eligibleOrders`, tested separately).
 */
export async function canonicalCategorySales(
  knex: Knex,
  joins: PA.ResolvedJoins,
  categoryId: number,
  start: Date,
  end: Date,
  options: CanonicalCategoryOptions = {},
): Promise<CanonicalCategorySales> {
  const includeDescendants = options.includeDescendants ?? true;
  const definition = options.definition ?? "settled";
  const tables = joins.categoryMembershipTables || [];
  if (tables.length === 0) {
    return { ordersCount: 0, units: 0, grossToman: 0, discountsToman: 0, refundsToman: 0, netToman: 0 };
  }

  const link = joins.categoryParentLink;
  const scope =
    includeDescendants && link
      ? `WITH RECURSIVE cat_scope AS (
           SELECT ?::int AS id
           UNION ALL
           SELECT cl.${link.childCol}::int
           FROM ${link.table} cl JOIN cat_scope ON cl.${link.parentCol} = cat_scope.id
         )`
      : `WITH cat_scope AS (SELECT ?::int AS id)`;

  // One EXISTS per membership table, OR-ed. A line is kept if its product is filed
  // under any in-scope category through any relation — and because this is EXISTS
  // rather than a join, matching several ways still keeps the line exactly once.
  const memberOf = tables
    .map(
      (t) =>
        `EXISTS (SELECT 1 FROM ${t} cm
                 WHERE cm.product_id = li.product_id
                   AND cm.product_category_id IN (SELECT id FROM cat_scope))`,
    )
    .join(" OR ");

  const sql = `
    ${scope}
    , ${PA.paidOrdersCte(joins, definition)}
    , raw_lines AS (
        SELECT
          oi.id AS item_id,
          o.id AS order_id,
          oi.count AS cnt,
          (oi.per_amount * oi.count)::numeric AS line_gross,
          po.order_discount,
          po.refund_irr,
          SUM((oi.per_amount * oi.count)::numeric) OVER (PARTITION BY o.id) AS order_gross,
          p.id AS product_id
        FROM order_items oi
        ${joins.oiToOrder}
        JOIN paid_orders po ON po.order_id = o.id
        LEFT JOIN order_items_product_variation_links oipv ON oipv.order_item_id = oi.id
        LEFT JOIN product_variations pv ON pv.id = oipv.product_variation_id
        ${PA.leftify(joins.variationToProduct)}
      )
    SELECT
      COUNT(DISTINCT li.order_id)::bigint AS orders_count,
      COALESCE(SUM(li.cnt), 0)::bigint AS units,
      COALESCE(SUM(li.line_gross), 0)::numeric AS gross,
      COALESCE(SUM(CASE WHEN li.order_gross > 0
                        THEN li.order_discount * li.line_gross / li.order_gross ELSE 0 END), 0)::numeric AS discounts,
      COALESCE(SUM(CASE WHEN li.order_gross > 0
                        THEN li.refund_irr * li.line_gross / li.order_gross ELSE 0 END), 0)::numeric AS refund_irr
    FROM raw_lines li
    WHERE ${memberOf}
  `;

  const res = await knex.raw(sql, [categoryId, start, end]);
  const row = rowsOf(res)[0] || {};
  const gross = Math.round(Number(row.gross) || 0);
  const discounts = Math.round(Number(row.discounts) || 0);
  const refunds = Math.round(PA.irrToToman(Number(row.refund_irr) || 0));
  return {
    ordersCount: Number(row.orders_count) || 0,
    units: Number(row.units) || 0,
    grossToman: gross,
    discountsToman: discounts,
    refundsToman: refunds,
    netToman: gross - discounts - refunds,
  };
}
