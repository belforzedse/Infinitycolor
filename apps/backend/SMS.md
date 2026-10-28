# IPPanel SMS

Infinitycolor sends SMS from backend code only. The shared implementation lives in `src/services/sms`, and Strapi's legacy `api::messaging.messaging` service delegates to it for OTP compatibility.

## Endpoint

IPPanel Edge API currently documents SMS sending under:

- Base URL: `https://edge.ippanel.com/v1`
- Pattern endpoint: `POST /api/send`
- Auth: `Authorization: <IP_PANEL_API_KEY>`

The request body uses `sending_type: "pattern"`, `from_number`, `code`, a single-item `recipients` array, and `params` for pattern variables.

Order lifecycle SMS uses `IP_PANEL_API_BASE_URL` and `IP_PANEL_PATTERN_ENDPOINT` because they make future Edge endpoint changes small. `IP_PANEL_API_URL` is still supported as an optional full URL override for order notifications only.

OTP SMS intentionally uses the legacy IPPanel endpoint hardcoded in `src/services/sms/ippanel.ts`: `https://api2.ippanel.com/api/v1/sms/pattern/normal/send`. It sends the legacy body shape with the `apiKey` header and does not read `IP_PANEL_API_URL`.

## Environment

Required when SMS is enabled:

```env
SMS_ENABLED=true
IP_PANEL_API_BASE_URL=https://edge.ippanel.com/v1
IP_PANEL_PATTERN_ENDPOINT=/api/send
IP_PANEL_API_KEY=replace_me
IP_PANEL_PATTERN_CODE=replace_me
IP_PANEL_SENDER=+983000505
```

Development and test environments should keep `SMS_ENABLED=false`. Tests set this explicitly so no real SMS is sent.

Optional per-event pattern env vars can override `IP_PANEL_PATTERN_CODE`: `IP_PANEL_PATTERN_OTP`, `IP_PANEL_PATTERN_ORDER_CREATED`, `IP_PANEL_PATTERN_ORDER_STATUS_UPDATED`, `IP_PANEL_PATTERN_SHIPPED`, and `IP_PANEL_PATTERN_CANCELLED`.

`IP_PANEL_PATTERN_STAFF_ORDER_STARTED` is the one exception: it is optional, and it does **not** fall back to `IP_PANEL_PATTERN_CODE`. Its code is pinned in `src/services/sms/config.ts` so the alert works on a fresh deploy; set the env var only to override that template. See "Staff order alert" below.

## Pattern Variables

Notification mappings live in `src/services/sms/notifications.ts`. The default params are:

- `code`: OTP code or order id fallback
- `orderId`: Strapi order id
- `status`: customer-facing Persian order status, derived from internal order status
- `trackingCode`: shipment tracking barcode, when available
- `amount`: order amount, when available
- `reason`: customer-facing Persian cancellation reason, when available

Internal statuses and common cancellation reason codes are mapped to short Persian labels before sending. Free-text Persian cancellation notes are preserved, while empty or technical English/internal values fall back to a customer-safe support cancellation reason.

The approved IPPanel pattern placeholders must match the params configured for the active pattern code.

## Staff order alert

`src/services/sms/staff-alerts.ts` notifies an internal recipient list when an order enters `Started` («در حال انجام»). It is the only fan-out sender: one message per enabled recipient, dispatched from the BullMQ worker rather than the request path.

Recipients are edited in the admin under **تنظیمات → پیامک اطلاع‌رسانی سفارش** and stored in `api::order-alert-setting.order-alert-setting`, a private single type with no core router. They deliberately do not live in `api::settings.settings`, which is served unauthenticated through `GET /site-settings` and edge-cached.

The registered pattern code is `yk33tn38qf9jsi7`, pinned as `DEFAULT_STAFF_ORDER_STARTED_PATTERN` in `src/services/sms/config.ts` and overridable through `IP_PANEL_PATTERN_STAFF_ORDER_STARTED`. It must declare exactly these four variables, and only these:

- `orderId`: Strapi order id
- `amount`: `contract.Amount` in تومان, Latin digits with thousands separators (`1,250,000`)
- `customer`: the delivery-address name, else the profile's first + last name. A human name only — `user.username` is never used, because OTP signup stores the phone number there
- `phone`: the delivery-address phone, else the account phone, rendered in the local dialling form (`09123381098`) rather than the stored `+98…` E.164 form

All four are always supplied — each falls back to `نامشخص` — because `sanitizePatternParams` drops undefined values and a declared-but-unsupplied variable leaves a hole in the delivered message.

This message carries a customer's phone number to every staff recipient. It is not written to any log: `sendPatternSms` logs the pattern code and provider response, never `params`.

Approved pattern text:

```
سفارش جدید در حال انجام
شماره سفارش: %orderId%
مشتری: %customer%
تماس: %phone%
مبلغ: %amount% تومان
اینفینیتی کالر
```

## Key Rotation

Rotate `IP_PANEL_API_KEY` in the deployment environment variable store, restart the backend processes, and verify a disabled-mode local test plus one controlled staging send. Never commit real API keys to this repository.

## Delayed shipping notification

Completing an order still moves it through `Done` to `Shipment` and starts Anipo
registration immediately. The customer shipping SMS is due 48 elapsed hours after
that successful action. Its due timestamp is persisted in the same order
transaction; a commerce-maintenance scheduler dispatches due messages every
minute, so worker downtime delays delivery rather than losing the timer.

The sender reads the current order and barcode at dispatch. Barcode updates do
not send an early SMS or move the deadline. The existing shipped pattern receives
`trackingCode` with the latest barcode, or `—` when no barcode is available.
Cancelled/returned orders are excluded. Historical shipped orders are not
backfilled, avoiding repeat messages for orders already notified before release.

The dispatcher locks one order at a time, deduplicates by its due timestamp, and
persists completion after provider acceptance. Known failures remain pending with
a five-minute retry interval. Transport timeouts, lost responses and server
errors are recorded as uncertain and are not resent automatically. Inspect the
order's SMS audit before manually retrying an uncertain submission.

Deployment requires the additive `2026.10.23T10.00.00.add-delayed-shipping-sms`
migration and the updated backend API, workers and scheduler. No new environment
variables or IPPanel pattern are required.
