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
  /**
   * Hierarchy, populated by the "category" dimension only. `parentKey` is null
   * for a top-level row; every other dimension leaves both undefined and is
   * rendered flat.
   */
  parentKey?: string | null;
  depth?: number;
}

/**
 * A report that ran, but not at full fidelity. Category membership and the category
 * tree are both resolved from the live schema and both degrade silently when the
 * expected tables aren't there — which is precisely how a category report can look
 * healthy while under-reporting. Degradation is therefore reported, never inferred
 * from the numbers.
 */
export interface SalesBreakdownWarning {
  code: "CATEGORY_HIERARCHY_UNAVAILABLE" | "CATEGORY_MEMBERSHIP_UNAVAILABLE";
  message: string;
}

export interface SalesBreakdownResult {
  dimension: SalesBreakdownDimension;
  rows: SalesBreakdownRow[];
  truncated: boolean;
  /** Which paid-orders definition produced these numbers (see PA.resolvePaidOrdersDefinition). */
  ordersDefinition: PA.PaidOrdersDefinition;
  /** Empty on a full-fidelity run. Non-empty means the numbers are known to be incomplete. */
  warnings: SalesBreakdownWarning[];
}

const MAX_BREAKDOWN_ROWS = 200;

/**
 * Cycle guard for the category ancestry walk. A well-formed tree here is two or
 * three levels; anything deeper is either a data error or a loop, and the walk
 * must terminate either way.
 */
const MAX_CATEGORY_DEPTH = 10;

/** Suffix marking the synthetic "sales sitting directly in this category" row. */
const SELF_ROW_SUFFIX = ":__self__";

/** Lazily resolves (and memoises) the paid-orders definition for this request. */
type DefinitionResolver = () => Promise<PA.PaidOrdersDefinition>;

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

/**
 * Truncation for the hierarchical category dimension.
 *
 * The flat `finalizeRows` would cap by net across all depths, which can fold a
 * child into "other" while keeping its parent — orphaning the child under a row
 * that still claims its revenue. So the cap applies to ROOTS, and a root that
 * doesn't survive takes its whole subtree into the "other" bucket with it.
 * Rows are then sorted globally by net desc (not tree pre-order): the client
 * rebuilds the hierarchy from `parentKey`, and the ranked chart on top of the
 * table keeps meaning "highest net first".
 */
function finalizeCategoryRows(
  rows: SalesBreakdownRow[],
  otherLabel: string,
): { rows: SalesBreakdownRow[]; truncated: boolean } {
  const present = new Set(rows.map((r) => r.key));
  const childrenOf = new Map<string, SalesBreakdownRow[]>();
  const roots: SalesBreakdownRow[] = [];
  for (const row of rows) {
    // A parentKey that isn't in the result set (its parent had no sales, or was
    // itself dropped) must not make the row vanish — treat it as a root.
    const parent = row.parentKey && present.has(row.parentKey) ? row.parentKey : null;
    if (parent === null) {
      roots.push(row);
      continue;
    }
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(row);
    else childrenOf.set(parent, [row]);
  }

  const sortedRoots = [...roots].sort((a, b) => b.netToman - a.netToman);
  const byNet = (list: SalesBreakdownRow[]) => [...list].sort((a, b) => b.netToman - a.netToman);
  if (sortedRoots.length <= MAX_BREAKDOWN_ROWS) {
    return { rows: byNet(rows), truncated: false };
  }

  const keptRoots = sortedRoots.slice(0, MAX_BREAKDOWN_ROWS - 1);
  const droppedRoots = sortedRoots.slice(MAX_BREAKDOWN_ROWS - 1);

  const collect = (root: SalesBreakdownRow): SalesBreakdownRow[] => {
    const out: SalesBreakdownRow[] = [];
    const stack = [root];
    while (stack.length) {
      const node = stack.pop()!;
      out.push(node);
      const kids = childrenOf.get(node.key);
      if (kids) stack.push(...kids);
    }
    return out;
  };

  const kept = keptRoots.flatMap(collect);
  // Only the dropped ROOTS are summed: their descendants are already included in
  // the root's rolled-up totals, so adding them too would double-count.
  const other = droppedRoots.reduce<SalesBreakdownRow>(
    (acc, r) => ({
      ...acc,
      ordersCount: acc.ordersCount + r.ordersCount,
      units: acc.units + r.units,
      grossToman: acc.grossToman + r.grossToman,
      discountsToman: acc.discountsToman + r.discountsToman,
      refundsToman: acc.refundsToman + r.refundsToman,
      netToman: acc.netToman + r.netToman,
    }),
    {
      key: "__other__",
      label: otherLabel,
      parentKey: null,
      depth: 0,
      ordersCount: 0,
      units: 0,
      grossToman: 0,
      discountsToman: 0,
      refundsToman: 0,
      netToman: 0,
    },
  );
  return { rows: byNet([...kept, other]), truncated: true };
}

/**
 * Every order in range grouped by `orders.Status`, INCLUDING the money each status
 * is carrying.
 *
 * This dimension deliberately does not use `paid_orders`. Its whole point is to
 * answer "what is sitting in each status", and `paid_orders` contains completed
 * orders only — routing the money columns through it reported 0 تومان for every
 * status except "تکمیل‌شده", which made the tab look like cancelled orders had no
 * value rather than showing how much value was lost to cancellation. Line totals
 * therefore come from the orders' own items and refunds straight from the
 * settlement ledger, for every status alike.
 *
 * Bindings: [start, end] x3 — the two per-order CTEs and the outer window.
 */
async function getSalesByStatus(
  knex: Knex,
  joins: PA.ResolvedJoins,
  resolveDefinition: DefinitionResolver,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  const definition = await resolveDefinition();
  const sql = `
    WITH all_item_totals AS (
      SELECT o.id AS order_id,
             SUM((oi.per_amount * oi.count)::numeric) AS gross,
             SUM(oi.count)::bigint AS units
      FROM order_items oi
      ${joins.oiToOrder}
      WHERE o.date BETWEEN ? AND ?
      GROUP BY o.id
    ),
    order_refunds AS (
      SELECT o.id AS order_id,
             COALESCE(SUM(
               CASE WHEN ct.status = 'Success' AND ct.type = 'Return' THEN ct.amount ELSE 0 END
             ), 0)::numeric AS refund_irr
      FROM orders o
      ${PA.leftify(joins.orderToContract)}
      ${PA.leftify(joins.contractToTx)}
      WHERE o.date BETWEEN ? AND ?
      GROUP BY o.id
    )
    SELECT
      o.status AS status,
      COUNT(*)::bigint AS orders_count,
      COALESCE(SUM(it.units), 0)::bigint AS units,
      COALESCE(SUM(it.gross), 0)::numeric AS gross,
      COALESCE(SUM(o.applied_discount_amount), 0)::numeric AS discounts,
      COALESCE(SUM(orf.refund_irr), 0)::numeric AS refund_irr
    FROM orders o
    LEFT JOIN all_item_totals it ON it.order_id = o.id
    LEFT JOIN order_refunds orf ON orf.order_id = o.id
    WHERE o.date BETWEEN ? AND ?
    GROUP BY o.status
  `;
  const res = await knex.raw(sql, [start, end, start, end, start, end]);
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
  return { dimension: "status", rows: finalRows, truncated, ordersDefinition: definition, warnings: [] };
}

const UNCATEGORIZED_LABEL = "بدون دسته‌بندی";

/**
 * The line-item projection both category queries build on: one row per order line,
 * carrying `order_id` so distinct order counts stay correct and `product_id` so
 * membership can be attached, with the discount/refund already pro-rated by the
 * line's share of its order's gross.
 *
 * Deliberately NOT joined to a category here. A line resolves to a PRODUCT; the
 * product's categories are a set, and attaching them at this level would multiply
 * the line's money once per category it belongs to. Membership is attached later,
 * as a separate relation that is already de-duplicated per (product, category).
 */
function categoryLinesCte(joins: PA.ResolvedJoins): string {
  const variationToProductLeft = PA.leftify(joins.variationToProduct);
  return `
    lines AS (
      SELECT
        itemized.order_id AS order_id,
        p.id AS product_id,
        itemized.cnt AS cnt,
        itemized.line_gross AS line_gross,
        CASE WHEN itemized.order_gross > 0
             THEN itemized.order_discount * itemized.line_gross / itemized.order_gross
             ELSE 0 END AS line_discount,
        CASE WHEN itemized.order_gross > 0
             THEN itemized.refund_irr * itemized.line_gross / itemized.order_gross
             ELSE 0 END AS line_refund
      FROM itemized
      LEFT JOIN product_variations pv ON pv.id = itemized.product_variation_id
      ${variationToProductLeft}
    )
  `;
}

/**
 * Every (product, category) pair the ROLLUP needs: each product paired with every
 * category it is filed under and with all of those categories' ancestors.
 *
 * De-duplicating here — on the product, not on the order line — is what keeps a
 * category's revenue correct AND the query cheap. A product filed under both a child
 * and that child's parent reaches the parent by two paths; `SELECT DISTINCT`
 * collapses them to one pair, so each of that product's order lines contributes to
 * the parent exactly once. Doing the same dedup per line would repeat the work for
 * every line of every order in the window instead of once per product.
 */
function productAncestorsCte(): string {
  return `
    product_ancestors AS (
      SELECT DISTINCT m.product_id, a.ancestor_id
      FROM product_category_membership m
      JOIN category_ancestry a ON a.category_id = m.product_category_id
    )
  `;
}

const LINE_AGGREGATES = `
  COUNT(DISTINCT l.order_id)::bigint AS orders_count,
  SUM(l.cnt)::bigint AS units,
  SUM(l.line_gross)::numeric AS gross,
  SUM(l.line_discount)::numeric AS discounts,
  SUM(l.line_refund)::numeric AS refund_irr
`;

/**
 * Flat fallback: one row per category a product is filed under, no hierarchy. Used
 * when the `parent` self-relation can't be resolved against this database, so a
 * schema drift costs the report its tree rather than the whole category tab.
 *
 * Membership is still main + other categories here; only the ROLLUP is missing.
 */
async function getSalesByCategoryFlat(
  knex: Knex,
  joins: PA.ResolvedJoins,
  resolveDefinition: DefinitionResolver,
  start: Date,
  end: Date,
  warnings: SalesBreakdownWarning[] = [],
): Promise<SalesBreakdownResult> {
  const definition = await resolveDefinition();
  const sql = `
    WITH ${PA.paidOrdersCte(joins, definition)}, ${PA.itemizedCte(joins)},
    ${PA.categoryMembershipCte(joins)},
    ${categoryLinesCte(joins)}
    SELECT
      m.product_category_id AS category_id,
      MAX(pc.title) AS category_title,
      ${LINE_AGGREGATES}
    FROM lines l
    LEFT JOIN product_category_membership m ON m.product_id = l.product_id
    LEFT JOIN product_categories pc ON pc.id = m.product_category_id
    GROUP BY m.product_category_id
  `;
  const res = await knex.raw(sql, [start, end]);
  const rows = rowsOf(res).map((r: any) => {
    const id = r.category_id === null || r.category_id === undefined ? "" : String(r.category_id);
    return {
      ...toRow({
        key: id,
        label: r.category_title ? String(r.category_title) : UNCATEGORIZED_LABEL,
        ordersCount: Number(r.orders_count) || 0,
        units: Number(r.units) || 0,
        gross: Number(r.gross) || 0,
        discounts: Number(r.discounts) || 0,
        refundIrr: Number(r.refund_irr) || 0,
      }),
      parentKey: null,
      depth: 0,
    };
  });
  const { rows: finalRows, truncated } = finalizeRows(rows, "سایر دسته‌بندی‌ها");
  return { dimension: "category", rows: finalRows, truncated, ordersDefinition: definition, warnings };
}

/**
 * The hierarchical category-breakdown statement. Exported so a test can assert the
 * membership/dedup shape of the SQL without a database, and so the exact statement
 * the report runs can be dumped for review against a real instance.
 */
export function categoryBreakdownSql(
  joins: PA.ResolvedJoins,
  definition: PA.PaidOrdersDefinition,
  link: PA.CategoryParentLink,
): string {
  const { table, childCol, parentCol } = link;
  return `
    WITH RECURSIVE ${PA.paidOrdersCte(joins, definition)}, ${PA.itemizedCte(joins)},
    ${PA.categoryMembershipCte(joins)},
    ${categoryLinesCte(joins)},
    ${PA.categoryAncestryCte(link, MAX_CATEGORY_DEPTH)},
    ${productAncestorsCte()},
    depths AS (
      SELECT category_id, MAX(up)::int AS depth FROM category_ancestry GROUP BY category_id
    ),
    -- Each line joins to its product's ancestor set, which is already distinct per
    -- (product, ancestor) — so a line lands in any given category exactly once no
    -- matter how many valid relationships connect its product to that category.
    subtree AS (
      SELECT pa.ancestor_id AS category_id, ${LINE_AGGREGATES}
      FROM lines l
      JOIN product_ancestors pa ON pa.product_id = l.product_id
      GROUP BY pa.ancestor_id
    ),
    -- (product, category) pairs where the product is filed on the category itself and
    -- on NONE of its descendants. A product filed on a child already shows in that
    -- child's row; counting it in the parent's "(مستقیم)" row as well is what made an
    -- expanded parent never add up. Resolved per product, like product_ancestors.
    -- category_id <> ancestor_id rather than up > 0, so a cycle can't hide a sale.
    product_direct_only AS (
      SELECT m.product_id, m.product_category_id
      FROM product_category_membership m
      WHERE NOT EXISTS (
        SELECT 1
        FROM product_category_membership m2
        JOIN category_ancestry a ON a.category_id = m2.product_category_id
        WHERE m2.product_id = m.product_id
          AND a.ancestor_id = m.product_category_id
          AND a.category_id <> m.product_category_id
      )
    ),
    -- Sales sitting only directly in a category. product_category_membership is a
    -- UNION, hence already distinct per (product, category): no extra dedup needed.
    direct AS (
      SELECT d.product_category_id AS category_id, ${LINE_AGGREGATES}
      FROM lines l
      JOIN product_direct_only d ON d.product_id = l.product_id
      GROUP BY d.product_category_id
    ),
    uncategorized AS (
      SELECT NULL::int AS category_id, ${LINE_AGGREGATES}
      FROM lines l
      WHERE NOT EXISTS (
        SELECT 1 FROM product_category_membership m WHERE m.product_id = l.product_id
      )
      HAVING COUNT(*) > 0
    )
    SELECT
      pc.id AS category_id,
      pc.title AS category_title,
      (SELECT cl2.${parentCol} FROM ${table} cl2 WHERE cl2.${childCol} = pc.id LIMIT 1) AS parent_id,
      COALESCE(dp.depth, 0) AS depth,
      r.orders_count, r.units, r.gross, r.discounts, r.refund_irr,
      d.orders_count AS direct_orders_count,
      d.units AS direct_units,
      d.gross AS direct_gross,
      d.discounts AS direct_discounts,
      d.refund_irr AS direct_refund_irr
    FROM subtree r
    JOIN product_categories pc ON pc.id = r.category_id
    LEFT JOIN depths dp ON dp.category_id = pc.id
    LEFT JOIN direct d ON d.category_id = pc.id
    UNION ALL
    SELECT
      NULL::int AS category_id, NULL::text AS category_title, NULL::int AS parent_id, 0 AS depth,
      u.orders_count, u.units, u.gross, u.discounts, u.refund_irr,
      NULL::bigint, NULL::bigint, NULL::numeric, NULL::numeric, NULL::numeric
    FROM uncategorized u
  `;
}

/**
 * Eligible-order line items rolled UP the category tree: every category reports
 * the sales of its whole subtree, so a parent that has no directly-assigned
 * products still gets a row and the top-level list accounts for all sales.
 *
 * The rollup is done in SQL on purpose. `ordersCount` is a distinct count, and
 * summing children into a parent on the client would count an order that spans
 * two sibling categories twice. Joining every line to all of its category's
 * ancestors and grouping by ancestor keeps the distinct count correct at every
 * depth.
 *
 * The "(مستقیم)" row under a parent holds only sales of products filed on the
 * parent and on none of its descendants, so an expanded parent's rows add up to
 * the parent EXCEPT where one product is filed under two of its subcategories.
 * Consequence worth knowing before filing it as a bug: NO column is additive in
 * general. A product belongs to every category it is filed under — main and
 * additional alike — so one line can legitimately appear under two sibling or
 * unrelated categories. Each row is individually correct and de-duplicated;
 * adding rows together is not a meaningful operation for orders, units, gross,
 * discounts, refunds or net.
 */
async function getSalesByCategory(
  knex: Knex,
  joins: PA.ResolvedJoins,
  resolveDefinition: DefinitionResolver,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  const link = joins.categoryParentLink;
  const noMembership = (joins.categoryMembershipTables || []).length === 0;
  if (!link || noMembership) {
    // Say which fidelity was lost. Without this the caller cannot tell a category
    // report missing its whole tree — or, worse, missing the additional-category
    // half of its membership — from a correct one.
    const warnings: SalesBreakdownWarning[] = [];
    if (noMembership) {
      warnings.push({
        code: "CATEGORY_MEMBERSHIP_UNAVAILABLE",
        message:
          "هیچ جدول ارتباط کالا و دسته‌بندی شناسایی نشد؛ گزارش دسته‌بندی خالی است.",
      });
    } else {
      warnings.push({
        code: "CATEGORY_HIERARCHY_UNAVAILABLE",
        message:
          "ساختار درختی دسته‌بندی‌ها قابل تشخیص نبود؛ فروش زیرمجموعه‌ها در دستهٔ والد جمع نشده است.",
      });
    }
    return getSalesByCategoryFlat(knex, joins, resolveDefinition, start, end, warnings);
  }
  const definition = await resolveDefinition();

  const sql = categoryBreakdownSql(joins, definition, link);
  const res = await knex.raw(sql, [start, end]);

  const raw = rowsOf(res);
  const subtreeRows: SalesBreakdownRow[] = [];
  const selfRows: SalesBreakdownRow[] = [];
  // A category counts as "having children with sales" only if some other row in
  // this result names it as its parent — that is what decides whether the
  // synthetic "(مستقیم)" row is needed to make an expanded parent add up.
  const parentsWithChildren = new Set(
    raw
      .map((r: any) => (r.parent_id === null || r.parent_id === undefined ? null : String(r.parent_id)))
      .filter((v: string | null): v is string => v !== null),
  );

  for (const r of raw) {
    const id = r.category_id === null || r.category_id === undefined ? "" : String(r.category_id);
    const label = r.category_title ? String(r.category_title) : UNCATEGORIZED_LABEL;
    const parentKey =
      r.parent_id === null || r.parent_id === undefined ? null : String(r.parent_id);
    subtreeRows.push({
      ...toRow({
        key: id,
        label,
        ordersCount: Number(r.orders_count) || 0,
        units: Number(r.units) || 0,
        gross: Number(r.gross) || 0,
        discounts: Number(r.discounts) || 0,
        refundIrr: Number(r.refund_irr) || 0,
      }),
      parentKey,
      depth: Number(r.depth) || 0,
    });

    const directGross = Number(r.direct_gross) || 0;
    const directUnits = Number(r.direct_units) || 0;
    if (id && parentsWithChildren.has(id) && (directGross !== 0 || directUnits !== 0)) {
      selfRows.push({
        ...toRow({
          key: `${id}${SELF_ROW_SUFFIX}`,
          // Self-describing on purpose: this row can surface in the ranked chart
          // and in the XLSX export, where a bare "directly here" names nothing.
          label: `${label} (مستقیم)`,
          ordersCount: Number(r.direct_orders_count) || 0,
          units: directUnits,
          gross: directGross,
          discounts: Number(r.direct_discounts) || 0,
          refundIrr: Number(r.direct_refund_irr) || 0,
        }),
        parentKey: id,
        depth: (Number(r.depth) || 0) + 1,
      });
    }
  }

  const { rows: finalRows, truncated } = finalizeCategoryRows(
    [...subtreeRows, ...selfRows],
    "سایر دسته‌بندی‌ها",
  );
  return { dimension: "category", rows: finalRows, truncated, ordersDefinition: definition, warnings: [] };
}

/** Eligible orders grouped by customer (guest / unresolved users get an explicit bucket). */
async function getSalesByCustomer(
  knex: Knex,
  joins: PA.ResolvedJoins,
  resolveDefinition: DefinitionResolver,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  if (!joins.orderToUser) {
    return { dimension: "customer", rows: [], truncated: false, ordersDefinition: "settled", warnings: [] };
  }
  const definition = await resolveDefinition();
  const sql = `
    WITH ${PA.paidOrdersCte(joins, definition)}, ${PA.itemizedCte(joins)},
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
  return { dimension: "customer", rows: finalRows, truncated, ordersDefinition: definition, warnings: [] };
}

/** Eligible orders grouped by `orders.DiscountCode` ('' bucketed as "no coupon used"). */
async function getSalesByCoupon(
  knex: Knex,
  joins: PA.ResolvedJoins,
  resolveDefinition: DefinitionResolver,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  const definition = await resolveDefinition();
  const sql = `
    WITH ${PA.paidOrdersCte(joins, definition)}, ${PA.itemizedCte(joins)},
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
  return { dimension: "coupon", rows: finalRows, truncated, ordersDefinition: definition, warnings: [] };
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
  resolveDefinition: DefinitionResolver,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  if (!joins.orderToAddress || !joins.addressToCity || !joins.cityToProvince) {
    return { dimension: "geography", rows: [], truncated: false, ordersDefinition: "settled", warnings: [] };
  }
  const definition = await resolveDefinition();
  const sql = `
    WITH ${PA.paidOrdersCte(joins, definition)}, ${PA.itemizedCte(joins)},
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
  return { dimension: "geography", rows: finalRows, truncated, ordersDefinition: definition, warnings: [] };
}

export async function getSalesBreakdown(
  knex: Knex,
  joins: PA.ResolvedJoins,
  dimension: SalesBreakdownDimension,
  start: Date,
  end: Date,
): Promise<SalesBreakdownResult> {
  // Resolved at most ONCE per request, and lazily: dimensions that short-circuit
  // on an unresolved join must still issue zero queries. WooCommerce-imported
  // orders have no gateway transactions, so a settled-only window matches nothing
  // and the whole breakdown reads as empty — the same reason productTrends does
  // this. Sharing one definition keeps two tabs of one report from disagreeing
  // about the same window.
  let pending: Promise<PA.PaidOrdersDefinition> | null = null;
  const resolveDefinition: DefinitionResolver = () => {
    pending ??= PA.resolvePaidOrdersDefinition(knex, joins, start, end);
    return pending;
  };
  switch (dimension) {
    case "status":
      return getSalesByStatus(knex, joins, resolveDefinition, start, end);
    case "category":
      return getSalesByCategory(knex, joins, resolveDefinition, start, end);
    case "customer":
      return getSalesByCustomer(knex, joins, resolveDefinition, start, end);
    case "coupon":
      return getSalesByCoupon(knex, joins, resolveDefinition, start, end);
    case "geography":
      return getSalesByGeography(knex, joins, resolveDefinition, start, end);
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
