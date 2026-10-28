# Storefront analytics event taxonomy

The event contract, firing conditions, purchase definition, dedupe rules, money
units, privacy rules, and the recommended Umami funnels live in
[`docs/analytics.md`](../../../docs/analytics.md). This note only covers how to
add an event.

- Emit through `src/lib/analytics/index.ts` (`track`, `trackAnalyticsEvent`,
  `trackFunnelStep`, `trackCheckoutFailure`, `trackPurchase`,
  `trackPaymentOutcome`). Never call `window.umami`.
- A new event name must be added to `EVENT_NAME_VALUES`, and every property to
  that event's `EVENT_PROPERTY_KEYS` entry; anything else is dropped.
- Fire outcome events after the server accepted the change, not on the click.
  Name intent events so they read as intent (`click_add_to_cart`,
  `place_order_attempt`).
- Put identifiers in event data, never in the event name. Only stable ids,
  counts, low-cardinality codes, and IRR money (`value_irr`) are allowed.
  `revenue` is reserved for `purchase`.
- `purchase` is emitted only by `app/payment/result` after the backend reports
  the order paid. Do not emit it anywhere else.
