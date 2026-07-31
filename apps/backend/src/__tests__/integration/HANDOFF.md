# Backend database-backed integration suite

The Tier 1 stock/reservation and payment-callback idempotency slices are implemented.
`tier1/payment-idempotency.int.spec.ts` proves successful settlement, duplicate callback
idempotency, failed verification, and cancelled callbacks against real Strapi/PostgreSQL
persistence. `tier1/stock-and-reservation.int.spec.ts` proves atomic stock and reservation
consume/release/expiry behavior.

External gateways, SMS, Redis, and frontend revalidation are disabled or mocked at their
provider boundaries. Business logic and persistence remain real. The harness refuses unsafe
database targets and supports either Testcontainers or the explicitly configured local CI
service database.

Run from the repository root:

```bash
pnpm --filter @repo/backend test:integration
```

Current expected result: 2 suites and 19 tests. Keep new integration scenarios database-backed,
in-band, self-cleaning, and free of arbitrary sleeps.
