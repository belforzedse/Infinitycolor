# Product Reporting — Metric Definitions

Authoritative reference for the super-admin product-intelligence workspace
(`/reports/products/*`). Every displayed metric is defined here, with its source,
included statuses, and known limitations. Implementation lives in
[`services/product-analytics.ts`](./services/product-analytics.ts) and
[`controllers/report.ts`](./controllers/report.ts).

## Sale definition (the base population)

An order counts as a **sale** when it has **net-positive successful settlement**
**and** is in fulfilment (`ELIGIBLE_ORDER_STATUSES`, decision D15).

```
paid_orders =
  orders o
  JOIN contracts c
  JOIN contract_transactions ct
  WHERE ct.status = 'Success'
    AND o.status IN ('Started', 'Shipment', 'Done')   -- the eligible-status gate
  GROUP BY order
  settled_irr = SUM(CASE WHEN ct.type = 'Return' THEN -ct.amount ELSE ct.amount END)
  HAVING settled_irr > 0          -- excludes fully-refunded / cancelled
  refund_irr  = SUM(ct.amount) WHERE ct.type = 'Return' AND ct.status = 'Success'
```

Consequences:

- Orders with no successful transaction are **excluded**. In practice that means
  `Paying` orders.
- The status gate is the second half of the definition and both halves must hold.
  An order left at `Paying` _after_ a successful charge (see
  `handleStockDecrementFailure`, which deliberately does this when stock cannot be
  decremented) is **not** counted: it has a `Success` row but no eligible status.
  Before decision D12 the CTE filtered on `ct.status` alone and such an order was
  counted; that is no longer true.
- `Started` («در حال انجام») **is** eligible (D15): it is where the gateway-success
  path leaves a settled order, `Done` being an admin-only transition. Use the sales
  status breakdown to tell accepted-but-unfinished from completed — the gate does
  not draw that line.
- Fully-refunded / `Cancelled` orders net to `<= 0` and are **excluded** — provided
  the refund is recorded as a `Return` transaction for the full paid amount. A
  refund written short leaves a positive residue and the order stays counted
  forever.
- Partial refunds keep the order (still net-positive) and reduce its metrics via `refund_irr`.
- Date window is applied to **`orders.date`** (the sale date), bucketed in the store timezone.

### The gateway visibility invariant

**A payment gateway appears in these reports only if its settlement path writes
`contract_transaction.Status = 'Success'`.** There is no fallback: an order whose
gateway never writes that row contributes zero to gross, net, units, order count,
AOV, trends and inventory velocity, and the gateway is absent from the breakdown.

This is not hypothetical. Mellat had **no `contract_transaction` writer at all** —
the callback verified, settled, decremented stock and set the order `Started`, but
never recorded a transaction — so every Mellat sale was invisible in every report,
silently, while the numbers looked entirely plausible. The same omission also made
Mellat's replay-idempotency check permanently unmatchable.

Two guards now exist against a recurrence:

- `gatewayBreakdownQuery` is rooted in `orders` with a `LEFT JOIN` onto
  `paid_orders`, so a gateway with orders but no settlement renders as an explicit
  zero row rather than vanishing. It previously inner-joined from `paid_orders`,
  which dropped such gateways entirely — and `withShares` then made the survivors
  sum to a confident 100%.
- `gatewaySettlementWarnings` compares each gateway's total order count against its
  settled count and emits a `dataQualityWarnings[]` entry when a gateway has orders
  but zero settled ones. The UI renders these as a warning, not a note.

When adding a gateway, the settlement path must write a `Success` transaction, and
refunds must be written as `Type: 'Return'` rows rather than by editing the original
charge downward — the CTE's `settled_irr`/`refund_irr` split depends on it.

All product-money metrics are then computed from the **`order_items`** of these
paid orders, using the immutable snapshot fields (`ProductTitle`, `ProductSKU`,
`PerAmount`, `Count`) so renamed/deleted products still report correctly.

## Currency & timezone

- `order_items.PerAmount` and product prices are **Toman**.
- `contract_transactions.amount` is **IRR**; divide by 10 → Toman (`irrToToman`).
- Timestamps are stored UTC; trend buckets shift to `REPORT_TIMEZONE`
  (default `Asia/Tehran`) before `date_trunc` so Jalali day boundaries are correct.

## Metric matrix

| Metric                          | Formula                                                                                   | Source                                                    | Included / excluded                              | Refund/cancel                | Limitations                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| Units sold                      | `Σ oi.Count`                                                                              | order_items of paid_orders                                | paid only                                        | net of fully-refunded orders | —                                                            |
| **Gross product sales** (Toman) | `Σ (oi.PerAmount × oi.Count)`                                                             | order_items                                               | product lines only — **excludes shipping & tax** | gross (pre-refund)           | —                                                            |
| Discounts (allocated)           | `Σ order.AppliedDiscountAmount × lineGross / orderGross`                                  | orders + order_items                                      | paid only                                        | —                            | order-level only; no per-item discount field → **pro-rated** |
| Refunds (allocated)             | `Σ (refund_irr/10) × lineGross / orderGross`                                              | contract_transactions `type='Return'`, `status='Success'` | paid only                                        | this _is_ the refund         | refunds are order/contract-level → **pro-rated** to items    |
| **Net product sales**           | `Gross − allocDiscount − allocRefund`                                                     | derived                                                   | paid only                                        | net                          | **estimate** (flagged “تخمینی”) due to pro-rating            |
| Orders with product             | `COUNT(DISTINCT order_id)`                                                                | order_items                                               | paid only                                        | —                            | —                                                            |
| Avg selling price               | `Gross / Units`                                                                           | derived                                                   | —                                                | —                            | gross basis                                                  |
| AOV                             | `Gross / paid orders`                                                                     | derived                                                   | —                                                | —                            | product-gross basis (excludes shipping/tax)                  |
| Current stock / status          | `product_stocks.Count`, `reserved_count`                                                  | product_variation → product_stock                         | live snapshot                                    | n/a                          | deleted variations → `unknown`                               |
| In / Low / Out                  | `Count > T` / `0 < Count ≤ T` / `Count ≤ 0`; `T = REPORT_LOW_STOCK_THRESHOLD` (default 5) | product_stocks                                            | active variations                                | n/a                          | threshold configurable                                       |
| Days of cover                   | `Count ÷ (unitsSold ÷ windowDays)`                                                        | derived                                                   | —                                                | n/a                          | estimate; `null`/∞ when no sales in window                   |
| Trend bucket                    | `date_trunc(grp, (orders.date AT TIME ZONE 'UTC') AT TIME ZONE tz)`                       | orders                                                    | paid only                                        | net                          | day/week/month auto-chosen by range                          |

## Previous-period comparison

KPIs compare against the immediately-preceding equal-length window
(`previousPeriod`). Percentage change is **`null` when the baseline is 0**
(`periodDelta`) so the UI renders “—” instead of a misleading ∞ / 100%.

## Validation & safety

- Sort is restricted to an allow-list (`PERFORMANCE_SORT_COLUMNS`) — arbitrary
  columns are rejected, preventing SQL injection via `sort`.
- `pageSize` is clamped to `MAX_PAGE_SIZE` (100); export is hard-capped at 10,000 rows.
- Date ranges are normalized (swapped if reversed).
- All endpoints require `Superadmin` or `Founder` (`ensureRoleAccess`, gated by
  `PRODUCT_REPORT_ROLES` in `controllers/report.ts`). **Correction:** this doc
  previously said "Superadmin or Store manager" — that has never matched the code.
  Store manager has no access to any `/reports/*` route today.
- Strapi link-table / FK names are resolved from `information_schema` **once per
  process** (memoized), replacing the previous per-request schema probing.

## Data gaps — deliberately NOT shown

These cannot be computed reliably from currently-recorded data:

- **Profit / margin** — no cost-of-goods field exists on product or variation.
- **Per-product conversion rate** — the behavior area exposes Umami product events,
  while this commerce report continues to use the authoritative, time-bounded
  `product_views` rollup described below.
- **Per-product brand** — there is no brand entity (only `site-identity` branding);
  filtering/grouping is by **category** only.
- **Historical stock-on-a-past-date / inventory aging** — `product_stock_log`
  records movements but reliable point-in-time reconstruction is not implemented;
  slow/fast-moving is derived from **sales velocity** in the window instead.

- **Per-product conversion rate** is now available for periods after the analytics
  expansion — see `docs/analytics/metric-dictionary.md#product_view_to_purchase_rate`
  — via a daily `analytics_product_view_daily` rollup of `product_views`. It has no
  history before that rollup started, and `product.SeenCount` remains cumulative-only.

To add profit/margin later: record unit cost on `product-variation` (**explicitly
declined for this release** — see `docs/analytics/analytics-decisions.md`, decision
1: cost data is unavailable and no `CostPrice` field will be added; do not infer or
estimate a margin figure). To add brand: introduce a brand content-type.
