/**
 * Central metric catalog.
 *
 * One canonical definition per KPI, so a new report reuses a definition instead of
 * recomputing it slightly differently. Every metric documents: business name,
 * technical id, exact formula, grain, source, included/excluded statuses, refund/
 * discount/tax/shipping treatment, currency, timezone, missing-data behaviour, and
 * known limitations — per docs/analytics/analytics-architecture.md.
 *
 * `status: "implemented"` entries are backed by real code in this repo (linked via
 * `implementation`). `status: "planned"` entries are documented for later phases
 * (see docs/analytics/analytics-decisions.md, decision D6) and are NOT computed
 * anywhere — no endpoint may claim to serve one. This file is a registry, not an
 * implementation; it intentionally has no I/O.
 */

export type MetricStatus = "implemented" | "planned" | "blocked";

export interface MetricDefinition {
  /** Stable technical identifier, e.g. "sales.net". Bump the suffix on a formula change. */
  id: string;
  /** Definition version tag surfaced in every response envelope (analytics-architecture.md). */
  definitionVersion: string;
  /** Persian business name shown in the UI. */
  businessName: string;
  /** English formula description (source of truth for reviewers/engineers). */
  formula: string;
  /** What one row represents, e.g. "one Tehran-local calendar day". */
  grain: string;
  source: "commerce" | "umami" | "commerce+umami";
  /** Strapi tables or external behavioral analytics dimensions this metric reads. */
  sourceTables: string[];
  includedStatuses: string;
  excludedStatuses: string;
  /** Which date field this metric buckets on. */
  dateBasis: string;
  refundTreatment: string;
  discountTreatment: string;
  taxTreatment: string;
  shippingTreatment: string;
  currency: "Toman" | "n/a";
  /** Usually "Asia/Tehran" or "n/a"; free text when the bucketing timezone needs a caveat. */
  timezone: string;
  missingDataBehavior: string;
  limitations: string[];
  status: MetricStatus;
  /** File:function implementing this metric, when status = "implemented". */
  implementation?: string;
}

const ELIGIBLE_ORDER_NOTE =
  "An order is 'eligible' when it has net-positive successful settlement: " +
  "SUM(contract_transactions.amount, Return rows negated) over Status='Success' rows " +
  "for the order's contract is > 0. This is orders.status-independent by design — " +
  "orders.Status is an operational/fulfillment field, not a settlement field, and the " +
  "payment-success path never advances it to 'Done' (that is an admin-only transition). " +
  "This is the SAME definition already used by every /reports/products/* endpoint " +
  "(product-analytics.ts paidOrdersCte), verified against scripts/seed-report-fixtures.js.";

export const METRIC_CATALOG: Record<string, MetricDefinition> = {
  "sales.eligibleOrders": {
    id: "sales.eligibleOrders",
    definitionVersion: "sales.eligibleOrders@2",
    businessName: "سفارش‌های واجد شرایط",
    formula:
      "COUNT(orders) WHERE orders.Status='Done' AND SUM(CASE WHEN contract_transactions.type='Return' " +
      "THEN -amount ELSE amount END) OVER contract_transactions.status='Success' rows > 0, grouped by order",
    grain: "one row per eligible order",
    source: "commerce",
    sourceTables: ["orders", "contracts", "contract_transactions"],
    includedStatuses: "orders.Status='Done' only, additionally gated on settlement",
    excludedStatuses:
      "any status other than 'Done' — including an order that was paid and then Cancelled; " +
      "orders with no Status='Success' transaction; orders net-refunded to <= 0",
    dateBasis: "orders.Date",
    refundTreatment: "Type='Return' transactions subtracted from settlement before the >0 test",
    discountTreatment:
      "not applied at this grain (order-level AppliedDiscountAmount reduces sales.net, not eligibility)",
    taxTreatment: "n/a to eligibility",
    shippingTreatment: "n/a to eligibility",
    currency: "n/a",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: [
      ELIGIBLE_ORDER_NOTE,
      "@2 added the orders.Status='Done' gate. Before it, settlement alone made an order eligible, so " +
        "an order paid and later Cancelled was counted as revenue, and the 'settled' and 'completed' " +
        "definitions described different order populations for the same window. This also resolves the " +
        "divergence with /reports/traffic/dashboard, which always used Status='Done'; the two now agree.",
      "Consequence of @2: an order that has been paid but not yet advanced to 'Done' by an operator " +
        "(e.g. Status='Started') contributes no revenue until it is completed.",
    ],
    status: "implemented",
    implementation: "src/api/report/analytics/sources/commerce.ts#getEligibleOrderStats",
  },

  "sales.categorySales": {
    id: "sales.categorySales",
    definitionVersion: "sales.categorySales@2",
    businessName: "فروش بر اساس دسته‌بندی",
    formula:
      "sales.gross / sales.units / COUNT(DISTINCT order_id) over the line items whose PRODUCT is a member " +
      "of the category or any of its descendants. Membership = product_main_category UNION " +
      "product_other_categories (a product belongs to every category it is filed under, not just its main one).",
    grain: "one row per category that has sales, rolled up over its whole subtree",
    source: "commerce",
    sourceTables: [
      "order_items",
      "orders",
      "product_variations",
      "products",
      "products_product_main_category_links",
      "products_product_other_categories_links",
      "product_categories",
      "product_categories_parent_links",
    ],
    includedStatuses: "eligible orders only (see sales.eligibleOrders)",
    excludedStatuses: "line items of non-eligible orders",
    dateBasis: "orders.Date",
    refundTreatment: "pro-rated to the line by its share of its order's gross (see sales.refunds)",
    discountTreatment: "pro-rated to the line by its share of its order's gross (see sales.discounts)",
    taxTreatment: "n/a (no line-level tax field)",
    shippingTreatment: "excludes shipping cost (product-line revenue only)",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior:
      "a line whose product is in no category is reported under an explicit 'بدون دسته‌بندی' row, never dropped",
    limitations: [
      "Rows are NOT additive. A product belongs to every category it is filed under, so one line can " +
        "legitimately appear under several unrelated categories, and a product whose additional category " +
        "is also an ancestor of its main category appears both in a child row and in the parent's " +
        "'(مستقیم)' row. Each row is individually de-duplicated and correct; summing rows is not meaningful " +
        "for any column, orders or money alike.",
      "A category's own row counts each order item exactly once no matter how many valid relationships " +
        "connect the product to that category (deduplicated on order_items.id).",
      "@2 fixed membership: before it, only product_main_category counted, so revenue from products filed " +
        "under a category via product_other_categories was missing from that category entirely.",
      "Membership is evaluated against products' CURRENT categories. Recategorising a product moves its " +
        "historical sales with it; there is no point-in-time category snapshot in this data model.",
    ],
    status: "implemented",
    implementation:
      "src/api/report/analytics/semantic/salesBreakdown.ts#categoryBreakdownSql",
  },

  "sales.gross": {
    id: "sales.gross",
    definitionVersion: "sales.gross@2",
    businessName: "فروش ناخالص",
    formula: "SUM(order_items.per_amount * order_items.count) over eligible orders' line items",
    grain: "one row per eligible order (or per day when aggregated)",
    source: "commerce",
    sourceTables: ["order_items", "orders", "contracts", "contract_transactions"],
    includedStatuses: "eligible orders only (see sales.eligibleOrders)",
    excludedStatuses: "line items of non-eligible orders",
    dateBasis: "orders.Date",
    refundTreatment: "gross is pre-refund; see sales.net for the refund-adjusted figure",
    discountTreatment: "gross is pre-discount; see sales.net",
    taxTreatment: "excludes shipping tax; there is no product/line tax field in this data model",
    shippingTreatment: "excludes shipping cost (product-line revenue only)",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: [
      "order_items has no line-total column; this is always PerAmount x Count, computed, not stored",
    ],
    status: "implemented",
    implementation: "src/api/report/services/product-analytics.ts#itemizedCte,aggCte",
  },

  "sales.discounts": {
    id: "sales.discounts",
    definitionVersion: "sales.discounts@2",
    businessName: "تخفیف",
    formula:
      "SUM(orders.applied_discount_amount) over eligible orders, pro-rated to line when itemized",
    grain: "one row per eligible order (or per day when aggregated)",
    source: "commerce",
    sourceTables: ["orders"],
    includedStatuses: "eligible orders only",
    excludedStatuses: "n/a",
    dateBasis: "orders.Date",
    refundTreatment: "independent of refunds",
    discountTreatment:
      "order-level only; there is no per-line discount field, so per-product discount is a pro-rated estimate",
    taxTreatment: "n/a",
    shippingTreatment: "n/a",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: ["coupon code is a denormalized snapshot on orders.DiscountCode; not joined here"],
    status: "implemented",
    implementation: "src/api/report/services/product-analytics.ts#paidOrdersCte",
  },

  "sales.refunds": {
    id: "sales.refunds",
    definitionVersion: "sales.refunds@2",
    businessName: "مرجوعی",
    formula:
      "SUM(contract_transactions.amount) WHERE type='Return' AND status='Success', divided by 10 for Toman",
    grain: "one row per eligible order (or per day when aggregated)",
    source: "commerce",
    sourceTables: ["contract_transactions"],
    includedStatuses: "Type='Return', Status='Success' only",
    excludedStatuses: "Pending/Failed return attempts are not counted as refunds",
    dateBasis: "orders.Date (the ORIGINAL order's date, not the refund transaction's own date)",
    refundTreatment: "this IS the refund figure",
    discountTreatment: "n/a",
    taxTreatment: "n/a",
    shippingTreatment:
      "refund of shipping cost is not separately tracked; treated as part of the transaction amount",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: [
      "there is no dedicated refund entity — a refund is inferred purely from a Type='Return' transaction row",
      "refund date != order date; use contract_transactions.date directly if a refund-processing-lag metric is needed (not implemented in this release)",
    ],
    status: "implemented",
    implementation: "src/api/report/services/product-analytics.ts#paidOrdersCte",
  },

  "sales.net": {
    id: "sales.net",
    definitionVersion: "sales.net@2",
    businessName: "فروش خالص",
    formula: "sales.gross - sales.discounts - sales.refunds",
    grain: "one row per eligible order (or per day when aggregated)",
    source: "commerce",
    sourceTables: ["order_items", "orders", "contract_transactions"],
    includedStatuses: "eligible orders only",
    excludedStatuses: "n/a",
    dateBasis: "orders.Date",
    refundTreatment: "subtracted",
    discountTreatment: "subtracted",
    taxTreatment: "excludes shipping tax (no product tax exists)",
    shippingTreatment: "excludes shipping cost",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: [
      "this is NET SALES, never labelled profit/margin — no cost data exists (decision D1)",
      "per-line net is a pro-rated estimate when discount/refund is allocated to individual products",
    ],
    status: "implemented",
    implementation: "src/api/report/analytics/sources/commerce.ts#getDailySalesTotals",
  },

  "sales.unitsSold": {
    id: "sales.unitsSold",
    definitionVersion: "sales.unitsSold@2",
    businessName: "تعداد فروش",
    formula: "SUM(order_items.count) over eligible orders' line items",
    grain: "one row per eligible order (or per day when aggregated)",
    source: "commerce",
    sourceTables: ["order_items"],
    includedStatuses: "eligible orders only",
    excludedStatuses: "n/a",
    dateBasis: "orders.Date",
    refundTreatment:
      "not decremented on partial refund (units shipped, not units kept) — no return-quantity field exists",
    discountTreatment: "n/a",
    taxTreatment: "n/a",
    shippingTreatment: "n/a",
    currency: "n/a",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: [
      "no per-line return-quantity field; a fully-refunded order's units still count here even though it is excluded from sales.gross via eligibility",
    ],
    status: "implemented",
    implementation: "src/api/report/services/product-analytics.ts#itemizedCte,aggCte",
  },

  "sales.averageOrderValue": {
    id: "sales.averageOrderValue",
    definitionVersion: "sales.averageOrderValue@2",
    businessName: "میانگین ارزش سفارش",
    formula: "sales.gross / sales.eligibleOrders (0 when eligibleOrders = 0)",
    grain: "one value per window",
    source: "commerce",
    sourceTables: ["order_items", "orders", "contract_transactions"],
    includedStatuses: "eligible orders only",
    excludedStatuses: "n/a",
    dateBasis: "orders.Date",
    refundTreatment: "gross basis (pre-refund) — see limitations",
    discountTreatment: "gross basis (pre-discount)",
    taxTreatment: "excludes shipping/tax",
    shippingTreatment: "excludes shipping",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0 when the denominator is 0, never Infinity/NaN",
    limitations: [
      "computed on product-gross, not net-of-refund settlement, matching the existing /reports/products/overview convention",
    ],
    status: "implemented",
    implementation: "src/api/report/controllers/report.ts#computeProductPeriod",
  },

  "liquidity.settled": {
    id: "liquidity.settled",
    definitionVersion: "liquidity.settled@1",
    businessName: "نقدینگی تسویه‌شده",
    formula:
      "SUM(contract_transactions.amount, Return rows negated) WHERE status='Success', divided by 10 for Toman",
    grain: "one row per bucket (day/week/month) by settlement date",
    source: "commerce",
    sourceTables: ["contract_transactions"],
    includedStatuses: "Status='Success' only",
    excludedStatuses: "Pending/Failed",
    dateBasis:
      "contract_transactions.date (settlement date, NOT orders.Date — this is a cash-movement view, distinct from sales.* which is an order-date sales view)",
    refundTreatment: "Return rows subtracted",
    discountTreatment: "n/a (transaction amount is already net of discount at settlement)",
    taxTreatment: "n/a",
    shippingTreatment:
      "included in the settled amount (shipping is charged through the same gateway transaction)",
    currency: "Toman",
    timezone:
      "n/a (bucketed on the raw transaction date, not Tehran-shifted — pre-existing behavior, unchanged by this work)",
    missingDataBehavior: "0, never null",
    limitations: [
      "corrected from IRR to Toman as of decision D4 — see docs/analytics/analytics-decisions.md",
      "not the same population as sales.eligibleOrders: this counts settlement events by their own date, not orders grouped by order date",
    ],
    status: "implemented",
    implementation: "src/api/report/controllers/report.ts#liquidity",
  },

  "liquidity.byGateway": {
    id: "liquidity.byGateway",
    definitionVersion: "liquidity.byGateway@1",
    businessName: "نقدینگی به تفکیک درگاه",
    formula:
      "SUM(contract_transactions.amount, Return rows negated) WHERE status='Success', grouped by payment_gateways.title, divided by 10 for Toman",
    grain: "one row per payment gateway",
    source: "commerce",
    sourceTables: ["contract_transactions", "payment_gateways"],
    includedStatuses: "Status='Success' only",
    excludedStatuses: "Pending/Failed",
    dateBasis: "contract_transactions.date",
    refundTreatment: "Return rows subtracted",
    discountTreatment: "n/a",
    taxTreatment: "n/a",
    shippingTreatment: "included",
    currency: "Toman",
    timezone: "n/a",
    missingDataBehavior:
      "0, never null; a gateway with no settled transactions in range does not appear as a row (unlike products/breakdown's gateway table, which explicitly zero-fills — this endpoint was not changed beyond the currency fix)",
    limitations: ["corrected from IRR to Toman as of decision D4"],
    status: "implemented",
    implementation: "src/api/report/controllers/report.ts#gatewayLiquidity",
  },

  // --- Planned (Phase 5) — documented, NOT computed anywhere. ---
  "customer.realizedLtv30d": {
    id: "customer.realizedLtv30d",
    definitionVersion: "customer.realizedLtv30d@0",
    businessName: "ارزش طول عمر مشتری (۳۰ روز، واقعی)",
    formula: "SUM(sales.net) per customer over the 30 days following their first eligible order",
    grain: "one row per customer",
    source: "commerce",
    sourceTables: ["orders", "order_items", "contract_transactions"],
    includedStatuses: "eligible orders only",
    excludedStatuses: "n/a",
    dateBasis: "orders.Date relative to the customer's first eligible order",
    refundTreatment: "net-of-refund (uses sales.net)",
    discountTreatment: "net-of-discount",
    taxTreatment: "n/a",
    shippingTreatment: "excluded (product net sales only)",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "n/a — not computed in this release",
    limitations: [
      "Phase 5, not implemented in this release — see docs/analytics/analytics-decisions.md decision D6",
    ],
    status: "planned",
  },
  "customer.contributionLtv": {
    id: "customer.contributionLtv",
    definitionVersion: "customer.contributionLtv@0",
    businessName: "ارزش طول عمر مشتری (سود ناخالص)",
    formula: "would require per-order-line cost data",
    grain: "one row per customer",
    source: "commerce",
    sourceTables: [],
    includedStatuses: "n/a",
    excludedStatuses: "n/a",
    dateBasis: "n/a",
    refundTreatment: "n/a",
    discountTreatment: "n/a",
    taxTreatment: "n/a",
    shippingTreatment: "n/a",
    currency: "n/a",
    timezone: "n/a",
    missingDataBehavior: "n/a",
    limitations: [
      "BLOCKED, not planned: no COGS/cost field exists anywhere in the schema, and none will be added " +
        "(decision D1 — the product owner confirmed cost data is unavailable). Do not implement, estimate, or fabricate this metric.",
    ],
    status: "blocked",
  },
};

export function getMetric(id: string): MetricDefinition | undefined {
  return METRIC_CATALOG[id];
}

export function listMetrics(status?: MetricStatus): MetricDefinition[] {
  const all = Object.values(METRIC_CATALOG);
  return status ? all.filter((m) => m.status === status) : all;
}
