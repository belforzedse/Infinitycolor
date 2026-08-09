# Storefront analytics event taxonomy

This document defines the approved provider-neutral storefront event schema.
The browser sends these events through `src/lib/analytics/index.ts`; the
collector is currently private Umami 3.2.

## Funnel events

Use `trackFunnelStep(...)` only for these client-side steps:

- `view_item`
- `add_to_cart`
- `begin_checkout`

Settled `purchase` revenue is authoritative on the backend and must never be
emitted by the browser. This prevents payment retries, duplicate tabs, and
unverified callback pages from creating conversions.

## Non-funnel events

Use the typed `track(eventName, payload)` entrypoint. The provider-neutral
`trackAnalyticsEvent(...)` category/action adapter is retained while existing
callsites are converted. The approved event names cover:

- `checkout`: `place_order_attempt`, `add_shipping_info`, `add_payment_info`,
  `payment_redirect`, `payment_completed`, `payment_callback_success`,
  `payment_callback_failed`, `payment_callback_error`,
  `order_success_page_view`, `order_failure_page_view`, `error`
- `ecommerce`: `view_cart`, `remove_from_cart`, `update_quantity`,
  `view_item_list`, `select_item`, `apply_coupon`
- `auth`: `login`, `account_created`
- `engagement`: `click_add_to_cart`, `share_product`, `open_comments`,
  `add_to_wishlist`, `remove_from_wishlist`
- `search`: `site_search`
- `content`: `content_impression`, `content_interaction`
- `adaptive_quality`: `tier_change`, `recovery_step`, `route_summary`,
  `web_vital_cls`, `web_vital_fcp`, `web_vital_inp`, `web_vital_lcp`,
  `web_vital_ttfb`

Actions are validated against a fixed list. Event properties are separately
allowlisted by action; arbitrary caller properties and free text are dropped.
Only stable product/category/variant identifiers, placement, quantity,
position, IRR value and currency, gateway code, result counts, route group,
release, and experiment tags are permitted. Site-search events additionally
permit the surface, zero-result flag, and query-length bucket described below.
Coupon codes, shipping identifiers, error strings, order identifiers, and free
text are never sent.

## Site search

`trackSiteSearch(query, surface, resultsCount)` records a `site_search` event
from the results page, where the actual count is known. The raw query is used
only to calculate a length bucket and is never sent. Email addresses, phone
numbers, card fragments, and other 7+ digit runs are rejected.

## Pageviews and privacy tiers

`AnalyticsTracker` loads the Umami 3.2 `telemetry.js` tracker with automatic
pageviews disabled. Native initialization remains enabled for performance and
SPA navigation state; no `data-umami-event` markup is used. Infinity emits one sanitized manual
pageview for the initial route and each `pushState`, `replaceState`, or
`popstate` navigation. Sensitive account, checkout, payment, order, and admin
paths are grouped; only an allowlist of UTM query parameters is retained.

Unknown, denied, and DNT sessions remain cookieless/basic: pageviews and event
names are available but custom event data and performance metrics are removed.
Explicit consent enables only the allowlisted context/event properties and
allowlisted performance fields. The signed-in internal customer ID remains an
opaque `identify` ID even without consent or with DNT. Guest correlation is
generated in memory and copied into order creation without browser storage.

## Session context

The only session context keys are `route_group`, `product_id`, `category_id`,
and `experiment`. Keep values stable and low-cardinality. Do not add a new custom
dimension for free text, raw capability data, URLs, query strings, order IDs,
or customer details.

## Dedupe and ownership

Use `onceKey` where React re-renders could repeat an event. The backend owns
settled purchase and refund reporting; the storefront owns intent, funnel-step,
navigation, search, and non-financial interaction signals.
