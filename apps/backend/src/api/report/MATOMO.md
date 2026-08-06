# Matomo Analytics — Backend & Reporting

How Matomo is integrated across the platform: reporting (read), server-side
ecommerce tracking (write), configuration, and capability boundaries.

## Architecture

```
Browser ──(matomo.js + _paq)──▶ Matomo  ◀──(Reporting API, token_auth)── Strapi report service
   pageviews / events / site search          server-side reads only,
   (lib/analytics/matomo.ts)                  normalized into typed DTOs

Strapi payment confirmation ──(Tracking API matomo.php, idgoal=0)──▶ Matomo
   server-side, idempotent, fire-and-forget (matomo-tracker.ts)
```

- **The Matomo API token never reaches the browser.** Only the frontend
  `NEXT_PUBLIC_MATOMO_URL` / `NEXT_PUBLIC_MATOMO_SITE_ID` are public.
- The reporting service (`services/matomo.ts`) calls a **fixed, hardcoded set of
  Matomo methods**. No request parameter can choose the method or override the
  base URL → no arbitrary proxying and no SSRF.
- Report endpoints (`/reports/traffic/dashboard`, `/reports/traffic/realtime`)
  are gated to the **Superadmin** role.

## Environment variables (backend)

| Var | Required | Notes |
| --- | -------- | ----- |
| `MATOMO_BASE_URL` | yes | `https://matomo.alpagency.net` (self-hosted, agency-managed) |
| `MATOMO_SITE_ID` | yes | prod = `2`, staging = `3` |
| `MATOMO_API_TOKEN` | yes | server-side only; used for Reporting + Tracking API |
| `MATOMO_TIMEOUT_MS` | no | default 8000 |
| `MATOMO_SERVER_TRACKING_ENABLED` | no | server ecommerce tracking; defaults **on** when configured. Set `false` to disable |
| `MATOMO_TRACKING_URL_BASE` | no | storefront origin used in tracked order URLs; falls back to `FRONTEND_BASE_URL` then `https://infinitycolor.co` |
| `REPORT_TIMEZONE` | no | default `Asia/Tehran`; report day boundaries |
| `TRAFFIC_DASHBOARD_CACHE_TTL_MS` / `TRAFFIC_REALTIME_CACHE_TTL_MS` | no | report cache TTLs |

Frontend: `NEXT_PUBLIC_MATOMO_URL`, `NEXT_PUBLIC_MATOMO_SITE_ID`,
`NEXT_PUBLIC_MATOMO_ENABLE_DEV` (opt-in to enable tracking in dev/test).

> **Resolved (Phase 2, see `docs/analytics/analytics-decisions.md`):**
> `apps/frontend/src/components/Analytics/MatomoTracker.tsx` used to hardcode a
> fallback of `https://matomo.alpagency.net` / site `2` for when
> `NEXT_PUBLIC_MATOMO_URL` / `NEXT_PUBLIC_MATOMO_SITE_ID` were unset at build
> time. That host/id happens to match this table's own `prod` values, but the
> fallback was still a hazard: a **staging** build missing its env vars would
> silently fall back to the *prod* site id (`2`) instead of failing loudly,
> mixing staging traffic into production analytics. The fallback has been
> removed — an unconfigured build now disables tracking entirely rather than
> guessing an environment.

## Reporting service (`services/matomo.ts`)

- Date boundaries are computed in `REPORT_TIMEZONE` (Asia/Tehran), not UTC.
- All sub-reports run via `Promise.allSettled` — a single failing/slow section
  degrades to empty data + a `tracking.sectionErrors` entry and
  `tracking.partial = true`, instead of failing the whole dashboard.
- `previousRange()` yields the immediately-preceding equal-length window;
  `comparison.*` deltas reuse `periodDelta` from `product-analytics.ts`
  (`changePct` is `null` when the baseline is 0 — never a misleading ∞/100%).
- `tracking.capabilities` reports which optional report areas responded, so the
  dashboard can hide/flag unavailable features rather than render broken panels.

### Currency reconciliation

The dashboard's **authoritative** orders/revenue come from Strapi contract
transactions (Toman). Matomo behavioral/ecommerce numbers are shown separately
and labeled as such. Server-side ecommerce tracking sends **Toman** amounts.
The site's configured "currency" in Matomo's admin is a **display/formatting**
setting only (per Matomo's Metadata API docs — currency symbol, not a value
transform); it does not rescale the `revenue` number returned by the Reporting
API, so a Toman-vs-IRR site-currency mismatch should **not**, on its own, make
Matomo's API-reported revenue disagree with Strapi's by 10×. This has not been
independently confirmed against Matomo's actual source for every code path,
so the reconciliation service (`reconcile/commerceReconciliation.ts`) still
flags a ~10×/~0.1× revenue ratio as `possibleCurrencyMismatch` defensively —
cheap insurance against this or any other unit mismatch, not a live known
issue.

## Server-side ecommerce tracking (`services/matomo-tracker.ts`)

`trackOrderToMatomo(strapi, orderId)` records a confirmed order to the Matomo
Tracking API (`matomo.php`, `idgoal=0`). It is invoked **fire-and-forget** from
`clearCartAfterPayment` (the gateway-agnostic success chokepoint) and:

- runs only after payment is verified and the order is committed;
- never throws into the payment path and is time-bounded — a slow/down Matomo
  cannot block, delay, or fail a payment (worst case: one missing data point);
- is **idempotent** via a Redis `SET NX` marker (`matomo:order-tracked:{id}`,
  30-day TTL). Refreshes, webhook retries, and repeated callbacks cannot
  double-record. If Redis is unavailable, tracking is **skipped** (a miss is
  safer than a duplicate);
- ties the order to the same opaque internal user id used client-side (`uid`),
  preserving cross-device attribution.

### Refunds & cancellations

**The previously documented workaround here did not work** and is no longer
attempted: re-sending an ecommerce order with the same `ec_id` to reduce
`revenue` is reported to fail with Matomo's own `"Invalid non-unique
idsite/idorder combination"` error — Matomo does not support updating or
cancelling a previously tracked order via the Tracking API. *(This specific
error string and the two referenced GitHub issue numbers are recalled, not
independently reproduced against this instance or Matomo's current source —
treat as a strong prior, not a verified fact, and confirm before relying on
the exact wording.)* There is no supported way to make a Matomo ecommerce
order reflect a later refund; this codebase does not attempt one — see
"Refund" below for what it does instead.

- Cancellation: the Strapi-truth revenue already excludes cancelled/fully-refunded
  orders (net settlement ≤ 0), so the authoritative dashboard figures stay correct
  regardless of Matomo.
- Refund: recorded as its own **`refund` event** (category `ecommerce`, a plain
  custom event via `matomo.php` — never a second ecommerce order), fired
  fire-and-forget from `trackRefundToMatomo` (`matomo-tracker.ts`) once per
  `contract_transactions` row created with `Type: "Return"`. Idempotent via
  Redis `SET NX` keyed by that row's id (not the order id — an order can be
  partially refunded more than once). Call sites: `adminCancel.ts`,
  `adminAdjustItems.ts`, and SnappPay's `applySnappayAdminUpdate`
  (`snappay-finalization.ts`) — always fired *after* the DB transaction that
  created the row has committed, never from inside it. Matomo's own
  ecommerce-order revenue for that `ec_id` is left as originally tracked
  (gross, pre-refund) and is never mutated; the gap between Matomo's gross
  figure and Strapi's net-of-refund figure is a reconciliation signal, not
  hidden.

## Capability matrix

| Capability | Status |
| ---------- | ------ |
| Visits summary, trend, referrers, pages, devices, countries | Core — implemented |
| Channel types, search engines, socials | Core — implemented now |
| Native Site Search (keywords + no-result) | Core — implemented now (frontend `trackSiteSearch` + report) |
| Browsers, OS families, languages, new-vs-returning | Core — implemented now |
| Previous-period comparison | Implemented now (computed server-side) |
| Server-side ecommerce orders | Implemented now |
| Server-side refund event | Implemented now (custom event, not a mutated order — see "Refunds & cancellations" above) |
| Custom dimensions (auth/page/product/category) | Implemented now (ids must be configured in Matomo admin) |
| Realtime (Live plugin) | Implemented |
| Funnels (multi-step), A/B testing, Form/Media Analytics | **Require paid Matomo On-Premise plugins.** **Verified absent** on the live instance via `docker exec matomo-app ls /var/www/html/plugins` (2026-08-05) — no Funnels/AbTesting/FormAnalytics/MediaAnalytics plugin directory exists; not installed and out of scope by product decision. *(The ≈$229/yr Funnels price is recalled, not independently verified — treat as approximate.)* `tracking.capabilities` does **not** detect or hide these — it only reports whether each *core* report section (`siteSearch`, `events`, `visitFrequency`) succeeded on the current request. The dashboard's "funnel" is `parseFunnelRows()`, an `Events.getAction` label match counting `nb_visits` (visit-level reach, fixed from a prior `nb_events` double-count) — a step-*reach* count, not the ordered, deduplicated per-visit funnel the Funnels plugin computes; `conversionFromPrevious` is capped at 100%. A true **segment-based** funnel (`segment=eventAction==X`) was evaluated and rejected: this instance runs `browser_archiving_disabled_enforce=1` (verified via `config.ini.php`), so an ad-hoc segment silently returns empty data unless pre-registered for background archiving — see `analytics-decisions.md` D10. |

## Broader report integration

`getProductBehavioral(slug, range)` is a reusable, fully-graceful helper
(returns `null` on any error/unconfigured) used by `report.productDetail` to add
a `behavioral` block (pageviews / unique / avg time / bounce) for a product's
`/pdp/{slug}` page — clearly distinct from the transactional truth in the same
response. The same helper pattern can be extended to search, promotion,
category, and checkout-failure reports.
