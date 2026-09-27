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
  "for the order's contract is > 0, AND the order is in fulfilment (orders.Status). " +
  "Eligibility was status-independent in @1, on the reasoning that Status is an " +
  "operational field and the payment-success path never advances it past 'Started'. " +
  "@2 rejected that: an order paid and then cancelled was revenue (see D12 Defect B). " +
  "@4 additionally excluded 'Started'; @5 put it back — an accepted, settled order is a " +
  "sale, and the status breakdown, not the gate, distinguishes completed from in-progress " +
  "(see D14 and D15). " +
  "This is the SAME definition already used by every /reports/products/* endpoint " +
  "(product-analytics.ts paidOrdersCte), verified against scripts/seed-report-fixtures.js.";

export const METRIC_CATALOG: Record<string, MetricDefinition> = {
  "sales.eligibleOrders": {
    id: "sales.eligibleOrders",
    definitionVersion: "sales.eligibleOrders@5",
    businessName: "سفارش‌های واجد شرایط",
    formula:
      "COUNT(orders) WHERE orders.Status IN ('Started','Shipment','Done') AND SUM(CASE WHEN contract_transactions.type='Return' " +
      "THEN -amount ELSE amount END) OVER contract_transactions.status='Success' rows > 0, grouped by order",
    grain: "one row per eligible order",
    source: "commerce",
    sourceTables: ["orders", "contracts", "contract_transactions"],
    includedStatuses: "orders.Status IN ('Started','Shipment','Done'), additionally gated on settlement",
    excludedStatuses:
      "Paying, Cancelled, Returned — including an order that was paid and then Cancelled; " +
      "orders with no Status='Success' transaction; orders net-refunded to <= 0",
    dateBasis:
      "orders.Date on order/product pages; contract_transactions.date (first successful non-Return leg) on money pages (clock=settlement) — decision D13",
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
      "@3 widened the gate to Started/Shipment/Done (decision D13). Started is WooCommerce 'processing': " +
        "paid and being fulfilled; excluding it hid 346 September orders. Paying/Cancelled/Returned stay out.",
      "@4 narrowed it again to Shipment/Done: a sale is an order the SHOP has completed. The " +
        "gateway-success path advances an order to Started and stops (Done is admin-only), so under @3 " +
        "«فروش» reported takings for orders nobody had accepted — on 2026-09-14 it showed 17 orders / " +
        "۴۴,۳۵۰,۰۰۰ تومان on a day with no completed order. The @3 motivation (346 hidden September " +
        "WooCommerce 'processing' orders) is spent: those days are all before FINANCIAL_DATA_FLOOR and " +
        "no money report can reach them.",
      "@5 (decision D15) re-widened the gate to Started/Shipment/Done, restoring @3's population. " +
        "Started («در حال انجام») is a settled order in fulfilment; under @4 «فروش» reported nothing " +
        "for it until an operator advanced it to Done, so the KPI row lagged the till by the " +
        "fulfilment desk and read zero on days the shop had taken money. Paying/Cancelled/Returned " +
        "stay out. The @4 concern — telling completed from merely-accepted — is answered by the " +
        "status breakdown's «شروع‌شده» row, which is status-independent and shows it directly.",
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
    shippingTreatment:
      "excludes shipping cost (product-line revenue only). The STORE-WIDE «فروش ناخالص» on " +
      "/reports/overview is sales.grossWithShipping, which adds it; this metric still backs every " +
      "per-product, per-category and per-status figure, where a delivery fee belongs to no row",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: [
      "order_items has no line-total column; this is always PerAmount x Count, computed, not stored",
      "shares its Persian business name with sales.grossWithShipping; the two differ by exactly " +
        "sales.shipping for the same window (decision D16)",
    ],
    status: "implemented",
    implementation: "src/api/report/services/product-analytics.ts#itemizedCte,aggCte",
  },

  "sales.shipping": {
    id: "sales.shipping",
    definitionVersion: "sales.shipping@1",
    businessName: "هزینه ارسال",
    formula: "SUM(orders.shipping_cost) over eligible orders",
    grain: "one row per eligible order (or per day when aggregated)",
    source: "commerce",
    sourceTables: ["orders", "contracts", "contract_transactions"],
    includedStatuses: "eligible orders only (see sales.eligibleOrders)",
    excludedStatuses: "n/a",
    dateBasis: "orders.Date on /reports/overview; the settlement clock on the liquidity pages",
    refundTreatment:
      "not adjusted — a refund of the delivery fee is not tracked separately (see sales.refunds)",
    discountTreatment:
      "the stored snapshot is what the customer was charged; a free-shipping promotion is already 0 here",
    taxTreatment:
      "orders.ShippingTax is carrier-side metadata for the Anipo barcode, not a customer charge, and is NOT added",
    shippingTreatment: "this IS the shipping figure",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: [
      "orders.shipping_cost is stored in Toman, NOT IRR — it must never be passed through irrToToman",
      "an order-level snapshot: a multi-parcel order still carries one figure",
    ],
    status: "implemented",
    implementation:
      "src/api/report/services/product-analytics.ts#shippingRevenueQuery; src/api/report/controllers/report.ts#computeProductPeriod",
  },

  "sales.grossWithShipping": {
    id: "sales.grossWithShipping",
    definitionVersion: "sales.grossWithShipping@1",
    businessName: "فروش ناخالص (نمای کلی فروش)",
    formula: "sales.gross + sales.shipping",
    grain: "one row per eligible order (or per day when aggregated)",
    source: "commerce",
    sourceTables: ["order_items", "orders", "contracts", "contract_transactions"],
    includedStatuses: "eligible orders only (see sales.eligibleOrders)",
    excludedStatuses: "line items and shipping of non-eligible orders",
    dateBasis: "orders.Date",
    refundTreatment: "pre-refund; see sales.net for the refund-adjusted figure",
    discountTreatment: "pre-discount; see sales.net",
    taxTreatment: "n/a — tax is disabled store-wide (cart computeTotals always returns 0)",
    shippingTreatment:
      "INCLUDED. This is the whole amount the order was written for; it equals the order total before " +
      "the discount is taken off (subtotal + shipping_cost)",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: [
      "store-wide only. Shipping is an order-level charge, so it cannot be attributed to a product, " +
        "category or line; every breakdown keeps sales.gross",
      "sales.net does NOT include shipping, so this is not net's pre-deduction base: the overview's " +
        "identity is grossWithShipping - shipping - discounts - refunds = net (decision D16)",
    ],
    status: "implemented",
    implementation: "src/api/report/controllers/report.ts#overview",
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
    definitionVersion: "sales.net@5",
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
    shippingTreatment:
      "excludes shipping cost — on EVERY page, including /reports/overview, whose gross " +
      "(sales.grossWithShipping) does include it. Net is merchandise (decision D16)",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior: "0, never null",
    limitations: [
      "this is NET SALES, never labelled profit/margin — no cost data exists (decision D1)",
      "per-line net is a pro-rated estimate when discount/refund is allocated to individual products",
      "@4: population follows sales.eligibleOrders@4 (Shipment/Done); no formula change",
      "@5: population follows sales.eligibleOrders@5 (Started/Shipment/Done); no formula change",
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
    definitionVersion: "liquidity.settled@2",
    businessName: "نقدینگی تسویه‌شده",
    formula:
      "SUM(paid_orders.settled_irr) over sales.eligibleOrders on the settlement clock, per Tehran bucket, divided by 10 for Toman",
    grain: "one row per Tehran calendar bucket (day/week/month) by settlement date, zero-filled",
    source: "commerce",
    sourceTables: ["orders", "contracts", "contract_transactions"],
    includedStatuses: "eligible orders only (sales.eligibleOrders@5)",
    excludedStatuses: "Paying/Cancelled/Returned orders and Pending/Failed transactions",
    dateBasis:
      "contract_transactions.date of the first successful non-Return leg (settlement date, NOT orders.Date); clock=order switches to orders.Date",
    refundTreatment: "Return rows subtracted",
    discountTreatment: "n/a (transaction amount is already net of discount at settlement)",
    taxTreatment: "n/a",
    shippingTreatment:
      "included in the settled amount (shipping is charged through the same gateway transaction)",
    currency: "Toman",
    timezone: "Asia/Tehran (bucket keys rendered in SQL as YYYY-MM-DD)",
    missingDataBehavior: "0, never null; missing buckets are filled with zero",
    limitations: [
      "corrected from IRR to Toman as of decision D4 — see docs/analytics/analytics-decisions.md",
      "@2 (decision D13): same population as sales.eligibleOrders, keyed on the settlement date. @1 summed every successful transaction in the database (cancelled orders included) by UTC day.",
      "a Return leg dated outside the window is not subtracted in that window (cash-movement view)",
    ],
    status: "implemented",
    implementation: "src/api/report/controllers/report.ts#liquidity",
  },

  "liquidity.byGateway": {
    id: "liquidity.byGateway",
    definitionVersion: "liquidity.byGateway@2",
    businessName: "نقدینگی به تفکیک درگاه",
    formula:
      "SUM(contract_transactions.amount, Return rows negated) over the successful legs of sales.eligibleOrders, grouped by COALESCE(contract_transactions.settlement_gateway, orders.payment_gateway), divided by 10 for Toman",
    grain: "one row per settlement channel; a split payment (wallet + gateway) contributes to two rows",
    source: "commerce",
    sourceTables: ["orders", "contracts", "contract_transactions"],
    includedStatuses: "eligible orders only (sales.eligibleOrders@5)",
    excludedStatuses: "Paying/Cancelled/Returned orders and Pending/Failed transactions",
    dateBasis: "settlement date by default (clock=settlement); all-orders counts always by orders.Date",
    refundTreatment: "Return rows subtracted",
    discountTreatment: "n/a",
    taxTreatment: "n/a",
    shippingTreatment: "included",
    currency: "Toman",
    timezone: "Asia/Tehran",
    missingDataBehavior:
      "0, never null; a gateway with orders but no settled transaction appears with ordersCount 0 and a data-quality warning",
    limitations: [
      "corrected from IRR to Toman as of decision D4",
      "@2 (decision D13): identical to products/breakdown's gateway table (same query, gated on report.finance.read). @1 grouped by the payment_gateways row linked to each transaction — duplicate rows, no Mellat row, 20k unlinked transactions — which is why the pie showed «نامشخص».",
      "per-row order counts do not sum to paidOrdersCount: a split payment sits under two channels; paymentMix splits paidOrdersCount into single- and multi-channel orders to reconcile them",
      "legs are attributed by settlement_gateway only for rows the WooCommerce importer wrote; live checkout transactions fall back to orders.payment_gateway",
    ],
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
