# Umami analytics — backend and reporting

Infinity uses the shared private Umami service (live version 3.3.1) for behavioral analytics. Commerce
remains authoritative for orders, revenue, refunds, discounts, and product sales.
The backend never exposes a generic provider proxy: each `/reports/behavior/*`
handler calls a fixed, allowlisted Umami endpoint and returns a validated DTO.

## Configuration

| Variable                             | Purpose                                                             |
| ------------------------------------ | ------------------------------------------------------------------- |
| `UMAMI_BASE_URL`                     | Private service origin, normally `https://analytics.alpagency.net`  |
| `UMAMI_WEBSITE_ID`                   | Environment-specific storefront UUID                                |
| `UMAMI_WEBSITE_ALLOWLIST`            | Comma-separated UUID allowlist; the configured site must be present |
| `UMAMI_USERNAME` / `UMAMI_PASSWORD`  | View-only service account used for reports                          |
| `UMAMI_API_TOKEN`                    | Optional managed-token alternative to reader credentials            |
| `UMAMI_HOSTNAME`                     | Sanitized storefront hostname attached to server commerce events    |
| `UMAMI_DATA_START_DATE`              | First trustworthy data date shown by every behavior response        |
| `UMAMI_TIMEOUT_MS`                   | Per-request timeout, default 8000 ms                                |
| `UMAMI_MAX_CONCURRENCY`              | Process-wide provider concurrency cap, default 6                    |
| `QUEUE_CRON_ANALYTICS_OUTBOX_REPAIR` | Repair/delivery cadence, default every minute                       |

## Server events

The contract and the reasons behind it are in [`docs/analytics.md`](../../../../../docs/analytics.md).
The revenue-bearing `purchase` is emitted by the storefront result page, not
here: Umami 3.3.1 keys sessions on IP + user agent, so a server event can never
join a shopper's funnel.

The outbox (`analytics/outbox.ts`) delivers two diagnostic events for storefront
orders created on or after the storefront cutover (`FINANCIAL_DATA_FLOOR`),
excluding WooCommerce-imported orders:

- `order_paid`: one per order once it has a settled charge; `value_irr` is the
  sum of its successful non-return legs. No `revenue` key and no distinct id.
- `refund`: one positive `refund_irr` per successful Return row.

The unique key is `(website_id, event_type, source_type, source_id)`. Delivery is
asynchronous, bounded, and retried with exponential backoff; exhausted rows
become `dead_letter` and appear in server logs and the traffic overview's
delivery-health panel. A scheduled repair scan finds settled orders and Return
rows with no outbox record. Rows of the retired server `purchase` type are left
in place and are neither delivered nor counted in delivery health. Provider
failure can never fail or delay payment, cancellation, or refund work.

## Reporting contract

The seven purpose-specific endpoints are overview, acquisition, conversion,
content, audience, performance, and realtime. Responses distinguish `ok`,
`empty`, `partial`, and `unavailable`; unavailable data is `null`, never zero.
Metadata always includes source, timezone, currency, definition version,
data-start date, refresh time, and cache state.

Historical responses cache for 60 seconds with stale-if-error, advanced reports
cache for five minutes, and realtime caches for ten seconds. Identical cold
provider requests are coalesced, reader tokens are refreshed once after an auth
failure, and every website id is a canonical UUID from the explicit allowlist.
