# IPPanel SMS

Infinitycolor sends SMS from backend code only. The shared implementation lives in `src/services/sms`, and Strapi's legacy `api::messaging.messaging` service delegates to it for OTP compatibility.

## Endpoint

IPPanel Edge API currently documents SMS sending under:

- Base URL: `https://edge.ippanel.com/v1`
- Pattern endpoint: `POST /api/send`
- Auth: `Authorization: <IP_PANEL_API_KEY>`

The request body uses `sending_type: "pattern"`, `from_number`, `code`, a single-item `recipients` array, and `params` for pattern variables.

`IP_PANEL_API_BASE_URL` and `IP_PANEL_PATTERN_ENDPOINT` are preferred because they make future endpoint changes small. `IP_PANEL_API_URL` is still supported as an optional full URL override for legacy or emergency migrations.

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

## Key Rotation

Rotate `IP_PANEL_API_KEY` in the deployment environment variable store, restart the backend processes, and verify a disabled-mode local test plus one controlled staging send. Never commit real API keys to this repository.
