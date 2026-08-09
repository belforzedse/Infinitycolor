# Umami analytics — backend and reporting

Infinity uses the shared private Umami service for behavioral analytics. Commerce
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

## Delivery guarantees

Successful settlement and Return transaction rows enqueue provider-neutral events
in `analytics_outbox`. The unique key is
`(website_id, event_type, source_type, source_id)`. Delivery is asynchronous,
bounded, and retried with exponential backoff; exhausted rows become
`dead_letter` and appear in server logs and the sales overview delivery-health
panel. A scheduled repair scan finds committed commerce rows with no matching
outbox record, covering the crash gap between settlement and enqueue.

- `purchase` contains positive `revenue` and `revenue_irr`, with `currency=IRR`.
- `refund` contains one positive `refund_irr` per successful Return row.
- Product payloads contain stable ids/SKUs, quantity, and IRR values only.
- Provider failure can never fail or delay payment, cancellation, or refund work.

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
