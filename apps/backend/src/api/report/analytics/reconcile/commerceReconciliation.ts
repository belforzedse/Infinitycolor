/**
 * Matomo <-> Strapi commerce reconciliation.
 *
 * Strapi's `paidOrdersCte`-based figures are authoritative; Matomo's server-side
 * ecommerce tracking is a best-effort, fire-and-forget secondary signal (see
 * `matomo-tracker.ts`). This module answers "how far apart are they, and does
 * that gap look like a known failure mode" — it is a data-health check, not a
 * ledger reconciliation, and does not attempt to make the two numbers match.
 *
 * Known, expected sources of divergence (not bugs):
 *  - Matomo undercounts: consent denial (cookieless but still may be blocked by
 *    the browser), ad-blockers, a slow/unavailable Matomo skipping the tracking
 *    call (matomo-tracker.ts never blocks or retries a failed send).
 *  - Matomo's order count is captured once at purchase time and never
 *    decremented for a later refund; Strapi's eligible-order count excludes
 *    orders that are now net-zero-or-negative after a refund. So
 *    `matomoOrders >= strapiOrders` is the expected direction whenever refunds
 *    occurred in the window, not a discrepancy to chase.
 *
 * See docs/analytics/analytics-decisions.md D10 for why this compares against
 * `Events.getAction`-adjacent `Goals.get(idGoal=ecommerceOrder)` rather than a
 * segment-based query, and for the currency-ratio caveat below.
 */

import * as PA from "../../services/product-analytics";
import { getDailySalesRollupRows } from "../sources/commerce";
import { getMatomoEcommerceSummary, type TrafficRange } from "../../services/matomo";

type Knex = any;

export type ReconciliationStatus = "matched" | "diverged" | "matomo_unavailable";

export interface CommerceReconciliationResult {
  window: { start: string; end: string };
  strapi: { orders: number; grossToman: number; netToman: number };
  matomo: { orders: number; revenue: number } | null;
  /** matomo.orders - strapi.orders. Null when Matomo is unavailable. */
  ordersDelta: number | null;
  /** matomo.revenue / strapi.grossToman. Null when Matomo is unavailable or strapi.grossToman is 0. */
  revenueRatio: number | null;
  /**
   * True when revenueRatio falls in ~[8,12] or ~[0.083,0.125] — the signature
   * of a 10x unit mismatch (e.g. IRR vs Toman). See MATOMO.md "Currency
   * reconciliation": this is cheap defensive insurance, not a live known
   * issue — kept because it hasn't been confirmed against Matomo's PHP
   * source that the site "currency" setting is purely a display concern.
   */
  possibleCurrencyMismatch: boolean;
  status: ReconciliationStatus;
}

const CURRENCY_MISMATCH_BAND_LOW = 8;
const CURRENCY_MISMATCH_BAND_HIGH = 12;
const CURRENCY_MISMATCH_BAND_INV_LOW = 1 / CURRENCY_MISMATCH_BAND_HIGH; // ~0.083
const CURRENCY_MISMATCH_BAND_INV_HIGH = 1 / CURRENCY_MISMATCH_BAND_LOW; // ~0.125

/**
 * "Broadly consistent" band for the revenue ratio when no currency-mismatch
 * signature is present. Deliberately coarse (Matomo undercounting is expected
 * and unpredictable in magnitude) — a starting point for Phase 6 hardening to
 * calibrate against real production data, not a statistically tuned bound.
 */
const MATCHED_RATIO_LOW = 0.5;
const MATCHED_RATIO_HIGH = 1.5;

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Reconcile a single window (typically one Tehran-local calendar day). Reuses
 * `getDailySalesRollupRows` — never redefines "eligible order" or revenue.
 */
export async function reconcileCommerceWindow(
  knex: Knex,
  joins: PA.ResolvedJoins,
  start: Date,
  end: Date,
): Promise<CommerceReconciliationResult> {
  const rows = await getDailySalesRollupRows(knex, joins, start, end);
  const strapi = rows.reduce(
    (acc, row) => ({
      orders: acc.orders + row.eligibleOrders,
      grossToman: acc.grossToman + row.grossToman,
      netToman: acc.netToman + row.netToman,
    }),
    { orders: 0, grossToman: 0, netToman: 0 },
  );

  const range: TrafficRange = { startDate: toDateOnly(start), endDate: toDateOnly(end) };
  const matomo = await getMatomoEcommerceSummary(range);

  if (!matomo) {
    return {
      window: { start: range.startDate, end: range.endDate },
      strapi,
      matomo: null,
      ordersDelta: null,
      revenueRatio: null,
      possibleCurrencyMismatch: false,
      status: "matomo_unavailable",
    };
  }

  const ordersDelta = matomo.orders - strapi.orders;
  const revenueRatio = strapi.grossToman > 0 ? matomo.revenue / strapi.grossToman : null;
  const possibleCurrencyMismatch =
    revenueRatio !== null &&
    ((revenueRatio >= CURRENCY_MISMATCH_BAND_LOW && revenueRatio <= CURRENCY_MISMATCH_BAND_HIGH) ||
      (revenueRatio >= CURRENCY_MISMATCH_BAND_INV_LOW &&
        revenueRatio <= CURRENCY_MISMATCH_BAND_INV_HIGH));

  const status: ReconciliationStatus = possibleCurrencyMismatch
    ? "diverged"
    : revenueRatio !== null && revenueRatio >= MATCHED_RATIO_LOW && revenueRatio <= MATCHED_RATIO_HIGH
      ? "matched"
      : "diverged";

  return {
    window: { start: range.startDate, end: range.endDate },
    strapi,
    matomo,
    ordersDelta,
    revenueRatio,
    possibleCurrencyMismatch,
    status,
  };
}

/** Idempotent upsert: re-running the same day overwrites, never duplicates. */
export async function upsertReconciliationRow(
  knex: Knex,
  bucketDate: string,
  result: CommerceReconciliationResult,
): Promise<void> {
  await knex.raw(
    `
    INSERT INTO analytics_reconciliation_daily
      (bucket_date, strapi_orders, strapi_gross_toman, strapi_net_toman,
       matomo_orders, matomo_revenue, orders_delta, revenue_ratio,
       possible_currency_mismatch, status, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
    ON CONFLICT (bucket_date) DO UPDATE SET
      strapi_orders = EXCLUDED.strapi_orders,
      strapi_gross_toman = EXCLUDED.strapi_gross_toman,
      strapi_net_toman = EXCLUDED.strapi_net_toman,
      matomo_orders = EXCLUDED.matomo_orders,
      matomo_revenue = EXCLUDED.matomo_revenue,
      orders_delta = EXCLUDED.orders_delta,
      revenue_ratio = EXCLUDED.revenue_ratio,
      possible_currency_mismatch = EXCLUDED.possible_currency_mismatch,
      status = EXCLUDED.status,
      computed_at = now()
    `,
    [
      bucketDate,
      result.strapi.orders,
      result.strapi.grossToman,
      result.strapi.netToman,
      result.matomo?.orders ?? null,
      result.matomo?.revenue ?? null,
      result.ordersDelta,
      result.revenueRatio,
      result.possibleCurrencyMismatch,
      result.status,
    ],
  );
}
