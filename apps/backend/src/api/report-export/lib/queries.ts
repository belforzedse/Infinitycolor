import * as PA from "../../report/services/product-analytics";
import { completeDayAnalyticsSql, ExportFilters, MAX_REPORT_ROWS } from "./filters";

export type ReportQuery = { sql: string; bindings: any[] };
export const customerSql = (joins: PA.ResolvedJoins) => ({
  joins: `${joins.orderToUser} ${joins.orderToUser ? joins.userToInfo : ""}`,
  name: joins.orderToUser && joins.userToInfo ? "NULLIF(TRIM(CONCAT_WS(' ', ui.first_name, ui.last_name)), '')" : "NULL::text",
  phone: joins.orderToUser ? "u.phone" : "NULL::text",
});
/** These are the order item's recorded attribute relations, not today's product. */
export const itemVariationSql = (joins: PA.ResolvedJoins) => ({
  joins: `${joins.oiToVariation.join}
    LEFT JOIN order_items_product_color_links hist_color ON hist_color.order_item_id = oi.id
    LEFT JOIN product_variation_colors recorded_color ON recorded_color.id = hist_color.product_variation_color_id
    LEFT JOIN order_items_product_size_links hist_size ON hist_size.order_item_id = oi.id
    LEFT JOIN product_variation_sizes recorded_size ON recorded_size.id = hist_size.product_variation_size_id
    LEFT JOIN order_items_product_variation_model_links hist_model ON hist_model.order_item_id = oi.id
    LEFT JOIN product_variation_models recorded_model ON recorded_model.id = hist_model.product_variation_model_id`,
  columns: `${joins.oiToVariation.idExpr}::text AS variation_id, recorded_color.title AS color, recorded_size.title AS size, recorded_model.title AS model`,
});

/** Only deterministic business references; TrackId can contain a payment token. */
export function walletReferenceExpr(joins: PA.ResolvedJoins): string {
  return `CASE WHEN ${PA.settlementGatewayExpr(joins)} = 'Wallet' THEN
    COALESCE(NULLIF(ct.external_id, ''),
      CASE WHEN ct.type = 'Return' AND ct.gateway_response ->> 'operation' = 'cancel'
        THEN 'wallet-refund-order-' || o.id::text || '-snappay-cancel'
      WHEN ct.type = 'Return' AND NULLIF(ct.gateway_response ->> 'operationId', '') IS NOT NULL
        AND ct.external_source = 'Wallet'
        THEN 'wallet-refund-order-' || o.id::text || '-snappay-update-' || (ct.gateway_response ->> 'operationId')
      END) END`;
}

/** Immutable reference formats written by checkout/refund services. No date guessing. */
export const ledgerOrderIdExpr = (alias = "wt") => `CASE
  WHEN ${alias}.reference_id ~ '^wallet-order-[0-9]+-.+' THEN split_part(${alias}.reference_id, '-', 3)
  WHEN ${alias}.reference_id ~ '^wallet-refund-order-[0-9]+-.+' THEN split_part(${alias}.reference_id, '-', 4)
  END`;

const topupReferenceMatch = (ledger = "wt", topup = "tu") => `NULLIF(${ledger}.reference_id, '') IS NOT NULL AND (
  ${ledger}.reference_id = NULLIF(${topup}.ledger_reference_id, '') OR
  ${ledger}.reference_id = NULLIF(${topup}.sale_reference_id, '') OR
  ${ledger}.reference_id = 'wallet-topup-' || ${topup}.gateway || '-' || NULLIF(${topup}.sale_reference_id, '')
)`;

export function paymentsQuery(joins: PA.ResolvedJoins, filters: ExportFilters): ReportQuery {
  const bindings: any[] = [filters.startAt, filters.endExclusive];
  const conditions: string[] = [];
  for (const [key, column] of [["provider", "provider"], ["orderStatus", "order_status"], ["transactionType", "kind"]]) {
    if (filters[key] && filters[key] !== "all") { conditions.push(`${column} = ?`); bindings.push(filters[key]); }
  }
  return { bindings, sql: `WITH period AS (SELECT ?::timestamp AS start_at, ?::timestamp AS end_at),
    contract_money AS (
      SELECT DISTINCT ct.id, o.id AS order_id, o.status AS order_status, ct.date,
        ${PA.settlementGatewayExpr(joins)} AS provider,
        CASE WHEN ct.type = 'Return' THEN 'refund' ELSE 'charge' END AS kind,
        ct.amount::text AS amount_irr, ${walletReferenceExpr(joins)} AS wallet_reference,
        NULLIF(ct.gateway_ref_id, '') AS provider_reference
      FROM orders o ${joins.orderToContract} ${joins.contractToTx}
      WHERE ct.status = 'Success'
    ), movements AS (
      SELECT 'CT:' || cm.id::text AS source_id, cm.date AT TIME ZONE 'UTC' AS date, cm.order_id::text AS order_id, cm.order_status,
        cm.provider, cm.kind, cm.amount_irr,
        CASE WHEN cm.provider = 'Wallet' THEN cm.wallet_reference ELSE cm.provider_reference END AS reference,
        mapped.id::text AS ledger_id, 'تراکنش موفق سفارش'::text AS evidence
      FROM contract_money cm CROSS JOIN period
      LEFT JOIN LATERAL (SELECT wt.id FROM local_user_wallet_transactions wt
        WHERE NULLIF(cm.wallet_reference, '') IS NOT NULL AND wt.reference_id = cm.wallet_reference
        ORDER BY wt.id LIMIT 1) mapped ON TRUE
      WHERE cm.date >= period.start_at AND cm.date < period.end_at
      UNION ALL
      SELECT 'TOPUP:' || tu.id::text, COALESCE(mapped.date, tu.date) AT TIME ZONE 'UTC', NULL::text, NULL::text,
        COALESCE(NULLIF(tu.gateway, ''), 'Unknown'), 'wallet-topup', tu.amount::text,
        COALESCE(NULLIF(tu.verification_reference, ''), NULLIF(tu.sale_reference_id, '')),
        mapped.id::text, CASE WHEN mapped.date IS NOT NULL THEN 'شارژ موفق کیف پول' ELSE 'شارژ موفق؛ تاریخ ثبت درخواست' END
      FROM wallet_topups tu CROSS JOIN period
      LEFT JOIN LATERAL (SELECT wt.id, wt.date FROM local_user_wallet_transactions wt
        WHERE ${topupReferenceMatch()} ORDER BY wt.id LIMIT 1) mapped ON TRUE
      WHERE tu.status = 'Success' AND COALESCE(mapped.date, tu.date) >= period.start_at AND COALESCE(mapped.date, tu.date) < period.end_at
      UNION ALL
      SELECT 'LEDGER:' || wt.id::text, wt.date AT TIME ZONE 'UTC', ${ledgerOrderIdExpr()}, o.status,
        CASE WHEN wt.cause = 'Wallet Topup' THEN
          CASE WHEN wt.reference_id ~ '^wallet-topup-(Mellat|SamanKish|ZarinPal)-' THEN split_part(wt.reference_id, '-', 3) ELSE 'Unknown' END
          ELSE 'Wallet' END,
        CASE WHEN wt.cause = 'Wallet Topup' THEN 'wallet-topup' WHEN wt.type = 'Add' THEN 'refund' ELSE 'charge' END,
        wt.amount::text, wt.reference_id, wt.id::text, 'سند کیف پول؛ بدون تراکنش متناظر'
      FROM local_user_wallet_transactions wt CROSS JOIN period
      LEFT JOIN orders o ON o.id::text = ${ledgerOrderIdExpr()}
      WHERE wt.date >= period.start_at AND wt.date < period.end_at
        AND ((wt.cause = 'Wallet Topup' AND wt.type = 'Add') OR ${ledgerOrderIdExpr()} IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM contract_money cm WHERE NULLIF(cm.wallet_reference, '') IS NOT NULL AND cm.wallet_reference = wt.reference_id)
        AND NOT EXISTS (SELECT 1 FROM wallet_topups tu WHERE tu.status = 'Success' AND ${topupReferenceMatch()})
    ) SELECT * FROM movements ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY date, source_id LIMIT ${MAX_REPORT_ROWS + 1}` };
}

/** Full ledger, with the adjustment audit joined exclusively by its ledger id. */
export function walletQuery(joins: PA.ResolvedJoins, filters: ExportFilters): ReportQuery {
  const conditions = ["wt.date >= ?", "wt.date < ?"];
  const bindings: any[] = [filters.startAt, filters.endExclusive];
  if (filters.direction !== "all") { conditions.push("wt.type = ?"); bindings.push(filters.direction === "credit" ? "Add" : "Minus"); }
  if (filters.kind === "adjustments") conditions.push("(adjustment.id IS NOT NULL OR wt.cause = 'Admin Wallet Adjustment' OR wt.reference_id ~ '^admin-adj-[0-9]+-.+')");
  if (filters.kind === "order-payments") conditions.push(`wt.type = 'Minus' AND ${ledgerOrderIdExpr()} IS NOT NULL`);
  return { bindings, sql: `SELECT wt.id::text AS id, wt.date AT TIME ZONE 'UTC' AS date, wt.type, wt.amount::text AS amount_irr,
    wt.reference_id AS reference, wt.cause, wt.note, ${ledgerOrderIdExpr()} AS order_id,
    w.id::text AS wallet_id, u.id::text AS customer_id, u.phone,
    ${joins.userToInfo ? "NULLIF(TRIM(CONCAT_WS(' ', ui.first_name, ui.last_name)), '')" : "NULL::text"} AS customer_name,
    adjustment.id::text AS adjustment_id, adjustment.actor_label AS actor, adjustment.actor_role AS actor_role,
    adjustment.reason, adjustment.before_irr, adjustment.after_irr
    FROM local_user_wallet_transactions wt
    LEFT JOIN local_user_wallet_transactions_user_wallet_links wl ON wl.local_user_wallet_transaction_id = wt.id
    LEFT JOIN local_user_wallets w ON w.id = wl.local_user_wallet_id
    LEFT JOIN local_user_wallets_user_links wu ON wu.local_user_wallet_id = w.id
    LEFT JOIN users u ON u.id = wu.user_id
    ${joins.userToInfo}
    LEFT JOIN LATERAL (
      SELECT m.id, COALESCE(NULLIF(m.actor_label, ''), NULLIF(m.performed_by_name, '')) AS actor_label,
        COALESCE(NULLIF(m.actor_role_name, ''), NULLIF(m.performed_by_role, '')) AS actor_role,
        m.metadata ->> 'reason' AS reason,
        (SELECT change ->> 'from' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.changes::jsonb) = 'array' THEN m.changes::jsonb ELSE '[]'::jsonb END) change WHERE change ->> 'field' = 'balance' LIMIT 1) AS before_irr,
        (SELECT change ->> 'to' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.changes::jsonb) = 'array' THEN m.changes::jsonb ELSE '[]'::jsonb END) change WHERE change ->> 'field' = 'balance' LIMIT 1) AS after_irr
      FROM manual_admin_activities m WHERE m.event_key = 'wallets.adjusted'
        AND m.metadata ->> 'ledgerId' = wt.id::text
      ORDER BY m.id LIMIT 1
    ) adjustment ON TRUE
    WHERE ${conditions.join(" AND ")} ORDER BY wt.date, wt.id LIMIT ${MAX_REPORT_ROWS + 1}` };
}

/** Orders selected by wallet debits in the requested period; funding is lifetime evidence. */
export function walletOrdersQuery(joins: PA.ResolvedJoins, filters: ExportFilters): ReportQuery {
  const ledger = walletQuery(joins, filters), customer = customerSql(joins);
  return { bindings: ledger.bindings, sql: `WITH selected_ledger AS (${ledger.sql}),
    selected_orders AS (
      SELECT order_id, SUM(amount_irr::numeric)::text AS period_wallet_irr
      FROM selected_ledger WHERE type = 'Minus' AND order_id IS NOT NULL GROUP BY order_id
    ), confirmed AS (
      SELECT DISTINCT o.id AS order_id, ct.id, ct.type, ct.amount,
        ${PA.settlementGatewayExpr(joins)} AS provider
      FROM selected_orders sel JOIN orders o ON o.id::text = sel.order_id
        ${joins.orderToContract} ${joins.contractToTx} WHERE ct.status = 'Success'
    ), funding AS (
      SELECT order_id,
        SUM(CASE WHEN type <> 'Return' AND provider = 'Wallet' THEN amount ELSE 0 END)::text AS wallet_charges_irr,
        SUM(CASE WHEN type <> 'Return' AND provider <> 'Wallet' THEN amount ELSE 0 END)::text AS other_charges_irr,
        SUM(CASE WHEN type = 'Return' AND provider = 'Wallet' THEN amount ELSE 0 END)::text AS wallet_refunds_irr,
        STRING_AGG(DISTINCT provider, '، ') FILTER (WHERE type <> 'Return' AND amount > 0) AS providers
      FROM confirmed GROUP BY order_id
    ) SELECT o.id::text AS order_id, o.date AT TIME ZONE 'UTC' AS date, o.status,
      ${customer.name} AS customer_name, ${customer.phone} AS phone,
      sel.period_wallet_irr, f.wallet_charges_irr, f.other_charges_irr, f.wallet_refunds_irr, f.providers
    FROM selected_orders sel JOIN orders o ON o.id::text = sel.order_id
      LEFT JOIN funding f ON f.order_id = o.id ${customer.joins}
    ORDER BY o.date, o.id LIMIT ${MAX_REPORT_ROWS + 1}` };
}

export function orderSelection(joins: PA.ResolvedJoins, filters: ExportFilters): ReportQuery {
  const bindings: any[] = [filters.startAt, filters.endExclusive];
  const conditions = ["o.date >= ?", "o.date < ?"];
  if (filters.orderStatus !== "all") { conditions.push("o.status = ?"); bindings.push(filters.orderStatus); }
  if (filters.provider !== "all") {
    conditions.push(`(o.payment_gateway = ? OR EXISTS (SELECT 1 FROM orders op
      ${joins.orderToContract.replace(/\bo\./g, "op.")} ${joins.contractToTx}
      WHERE op.id = o.id AND ct.status = 'Success' AND ${PA.settlementGatewayExpr(joins).replace(/\bo\./g, "op.")} = ?))`);
    bindings.push(filters.provider, filters.provider);
  }
  return { sql: `SELECT o.id FROM orders o WHERE ${conditions.join(" AND ")}`, bindings };
}

export function ordersQuery(joins: PA.ResolvedJoins, filters: ExportFilters): ReportQuery {
  const selection = orderSelection(joins, filters), customer = customerSql(joins);
  return { bindings: selection.bindings, sql: `WITH selected AS (${selection.sql})
    SELECT o.id::text AS id, o.external_id, o.date AT TIME ZONE 'UTC' AS date, o.status, o.payment_gateway AS provider,
      ${customer.name} AS customer_name, ${customer.phone} AS phone,
      COALESCE(o.shipping_cost, 0)::text AS shipping_toman, COALESCE(o.applied_discount_amount, 0)::text AS discount_toman,
      COALESCE(items.units, 0)::text AS units, COALESCE(items.gross_toman, 0)::text AS gross_toman,
      COALESCE(money.charges, 0)::text AS charges_irr, COALESCE(money.refunds, 0)::text AS refunds_irr,
      COALESCE(money.net, 0)::text AS net_irr, money.providers, money.paid_at AT TIME ZONE 'UTC' AS paid_at
    FROM selected sel JOIN orders o ON o.id = sel.id ${customer.joins}
    LEFT JOIN LATERAL (SELECT SUM(oi.count)::numeric AS units, SUM(oi.per_amount::numeric * oi.count)::numeric AS gross_toman
      FROM order_items oi ${joins.oiToOrder.replace(/\bo\b/g, "item_order")}
      WHERE item_order.id = o.id) items ON TRUE
    LEFT JOIN LATERAL (SELECT
      SUM(CASE WHEN ct.type <> 'Return' THEN ct.amount ELSE 0 END)::numeric AS charges,
      SUM(CASE WHEN ct.type = 'Return' THEN ct.amount ELSE 0 END)::numeric AS refunds,
      SUM(CASE WHEN ct.type = 'Return' THEN -ct.amount ELSE ct.amount END)::numeric AS net,
      STRING_AGG(DISTINCT ${PA.settlementGatewayExpr(joins)}, '، ') AS providers,
      MIN(ct.date) FILTER (WHERE ct.type <> 'Return') AS paid_at
      FROM orders money_order ${joins.orderToContract.replace(/\bo\b/g, "money_order")} ${joins.contractToTx}
      WHERE money_order.id = o.id AND ct.status = 'Success') money ON TRUE
    ORDER BY o.date, o.id LIMIT ${MAX_REPORT_ROWS + 1}` };
}

export function orderItemsQuery(joins: PA.ResolvedJoins, filters: ExportFilters): ReportQuery {
  const selection = orderSelection(joins, filters), variation = itemVariationSql(joins);
  return { bindings: selection.bindings, sql: `WITH selected AS (${selection.sql})
    SELECT oi.id::text AS id, o.id::text AS order_id, oi.product_sku AS sku, oi.product_title AS title,
      oi.count, oi.per_amount::text AS price_toman, (oi.per_amount::numeric * oi.count)::text AS gross_toman,
      ${variation.columns}
    FROM order_items oi ${joins.oiToOrder} JOIN selected sel ON sel.id = o.id ${variation.joins}
    ORDER BY o.date, o.id, oi.id LIMIT ${MAX_REPORT_ROWS + 1}` };
}

export function productBuyersQuery(joins: PA.ResolvedJoins, filters: ExportFilters): ReportQuery {
  const customer = customerSql(joins), variation = itemVariationSql(joins);
  return { bindings: [filters.startAt, filters.endExclusive, ...filters.productCodes!], sql: `WITH ${completeDayAnalyticsSql(PA.paidOrdersCte(joins, "settled", "settlement"))}
    SELECT oi.id::text AS id, o.id::text AS order_id, infinity_order_sku(oi.product_sku) AS sku, oi.product_title AS title,
      oi.count, oi.per_amount::text AS price_toman, (oi.per_amount::numeric * oi.count)::text AS gross_toman,
      po.settled_at AT TIME ZONE 'UTC' AS paid_at, o.status, ${customer.name} AS customer_name, ${customer.phone} AS phone,
      ${joins.orderToUser ? "u.id::text" : "NULL::text"} AS customer_id, ${variation.columns}
    FROM order_items oi ${joins.oiToOrder} JOIN paid_orders po ON po.order_id = o.id ${customer.joins} ${variation.joins}
    WHERE infinity_order_sku(oi.product_sku) IN (${filters.productCodes!.map(() => "?").join(", ")})
    ORDER BY po.settled_at, o.id, oi.id LIMIT ${MAX_REPORT_ROWS + 1}` };
}

/** Select with the requested movement filters, then show ALL successful funding legs. */
export function splitPaymentsQuery(joins: PA.ResolvedJoins, filters: ExportFilters): ReportQuery {
  const movement = paymentsQuery(joins, filters), customer = customerSql(joins);
  return { bindings: movement.bindings, sql: `WITH selected_movements AS (${movement.sql}),
    selected_orders AS (SELECT DISTINCT order_id FROM selected_movements WHERE order_id IS NOT NULL),
    funding AS (
      SELECT o.id AS order_id, ${PA.settlementGatewayExpr(joins)} AS provider,
        SUM(CASE WHEN ct.type <> 'Return' THEN ct.amount ELSE 0 END)::numeric AS charges,
        SUM(CASE WHEN ct.type = 'Return' THEN ct.amount ELSE 0 END)::numeric AS refunds
      FROM selected_orders sel JOIN orders o ON o.id::text = sel.order_id
        ${joins.orderToContract} ${joins.contractToTx}
      WHERE ct.status = 'Success'
      GROUP BY o.id, ${PA.settlementGatewayExpr(joins)}
    ), split_orders AS (
      SELECT order_id,
        STRING_AGG(provider, '، ' ORDER BY provider) FILTER (WHERE charges > 0) AS providers,
        COUNT(*) FILTER (WHERE charges > 0)::integer AS funding_channels,
        COALESCE(SUM(charges) FILTER (WHERE provider = 'Wallet'), 0)::text AS wallet_charges_irr,
        COALESCE(SUM(refunds) FILTER (WHERE provider = 'Wallet'), 0)::text AS wallet_refunds_irr,
        COALESCE(SUM(charges) FILTER (WHERE provider <> 'Wallet'), 0)::text AS other_charges_irr,
        COALESCE(SUM(refunds) FILTER (WHERE provider <> 'Wallet'), 0)::text AS other_refunds_irr,
        SUM(charges)::text AS charges_irr, SUM(refunds)::text AS refunds_irr,
        SUM(charges - refunds)::text AS net_irr
      FROM funding GROUP BY order_id HAVING COUNT(*) FILTER (WHERE charges > 0) > 1
    ) SELECT o.id::text AS order_id, o.date AT TIME ZONE 'UTC' AS date, o.status,
      split.providers, split.funding_channels, split.wallet_charges_irr, split.wallet_refunds_irr,
      split.other_charges_irr, split.other_refunds_irr, split.charges_irr, split.refunds_irr, split.net_irr,
      ${customer.name} AS customer_name, ${customer.phone} AS phone,
      COALESCE(items.gross_toman, 0)::text AS gross_toman,
      COALESCE(o.shipping_cost, 0)::text AS shipping_toman, COALESCE(o.applied_discount_amount, 0)::text AS discount_toman
    FROM split_orders split JOIN orders o ON o.id = split.order_id ${customer.joins}
    LEFT JOIN LATERAL (SELECT SUM(oi.per_amount::numeric * oi.count)::numeric AS gross_toman
      FROM order_items oi ${joins.oiToOrder.replace(/\bo\b/g, "item_order")} WHERE item_order.id = o.id) items ON TRUE
    ORDER BY o.date, o.id LIMIT ${MAX_REPORT_ROWS + 1}` };
}

export function inventoryVariationsQuery(joins: PA.ResolvedJoins, productId: string): ReportQuery {
  return { bindings: [productId], sql: `SELECT pv.id::text AS variation_id, pv.sku, p.id::text AS product_id, p.title,
      ${joins.variationToColor.titleExpr} AS color, ${joins.variationToSize.titleExpr} AS size,
      ${joins.variationToModel.titleExpr} AS model,
      ${joins.variationToStock ? "ps.id::text" : "NULL::text"} AS stock_id,
      ${joins.variationToStock ? "ps.count" : "NULL::integer"} AS current_count,
      ${joins.variationToStock ? "ps.reserved_count" : "NULL::integer"} AS reserved_count
    FROM product_variations pv ${joins.variationToProduct} ${joins.variationToStock}
      ${joins.variationToColor.join} ${joins.variationToSize.join} ${joins.variationToModel.join}
    WHERE p.id = ? ORDER BY pv.id LIMIT ${MAX_REPORT_ROWS + 1}` };
}

/** A code may have changed or been freed by purge; surviving identities win over the code. */
function historicalProductJoins(joins: PA.ResolvedJoins): string {
  // resolveJoins includes pv for relation-table installations; direct foreign
  // keys need it added here. Product joins must stay optional for detached history.
  const variation = joins.oiToVariation.join || `LEFT JOIN product_variations pv ON pv.id = ${joins.oiToVariation.idExpr}`;
  const product = joins.variationToProduct.replace(/\b(?:INNER\s+|LEFT\s+)?JOIN\b/g, "LEFT JOIN");
  return `${variation} ${product}`;
}
export function inventoryProductCandidatesQuery(joins: PA.ResolvedJoins, productCode: string): ReportQuery {
  return { bindings: [productCode, productCode], sql: `SELECT product_id FROM (
    SELECT p.id::text AS product_id FROM product_variations pv ${joins.variationToProduct}
      WHERE infinity_order_sku(pv.sku) = ? AND p.id IS NOT NULL
    UNION
    SELECT p.id::text AS product_id FROM order_items oi ${historicalProductJoins(joins)}
      WHERE infinity_order_sku(oi.product_sku) = ? AND p.id IS NOT NULL
    ) identities LIMIT 2` };
}

export function inventoryOrdersQuery(joins: PA.ResolvedJoins, productId: string, skus: string[]): ReportQuery {
  return { bindings: [productId, ...skus], sql: `SELECT oi.id::text AS id, o.id::text AS order_id, o.date AT TIME ZONE 'UTC' AS date, o.status,
    o.reservation_status, o.manual_stock_applied_at AT TIME ZONE 'UTC' AS manual_stock_applied_at, o.payment_gateway AS provider,
    oi.product_sku AS sku, oi.product_title AS title, oi.count,
    ${joins.oiToVariation.idExpr}::text AS variation_id
    FROM order_items oi ${joins.oiToOrder} ${historicalProductJoins(joins)}
    WHERE ${joins.oiToVariation.idExpr} IN (SELECT pv.id FROM product_variations pv ${joins.variationToProduct} WHERE p.id = ?)
      ${skus.length ? `OR (p.id IS NULL AND infinity_order_sku(oi.product_sku) IN (${skus.map(() => "?").join(", ")}))` : ""}
    ORDER BY o.date, o.id, oi.id LIMIT ${MAX_REPORT_ROWS + 1}` };
}
