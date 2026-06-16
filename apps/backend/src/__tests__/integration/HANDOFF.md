# Handoff — Backend Jest integration layer (next increment: payment-callback idempotency)

You are continuing a multi-increment effort to give the Strapi v4 backend a **real-DB
Jest integration layer** with genuine QA value. Increment 1 (harness + Tier 1 stock/
reservation) is **done and green**. Your job is the **next slice: payment-callback
idempotency** (the second half of the plan's Tier 1).

The approved master plan is at `C:\Users\User\.claude\plans\you-are-claude-opus-peppy-steele.md`.
Read it for the full architecture and the Tier 1/2/3 priority list. This doc gets you
productive fast.

---

## 1. What already exists (don't rebuild it)

Layered Jest, two configs:
- **Unit layer** (fast, mocked `strapi` global): `apps/backend/jest.config.js`, files `*.spec.ts`.
  Run: `pnpm --filter @repo/backend test:unit`. Currently 49 suites / 562 tests green.
- **Integration layer** (REAL Strapi + REAL Postgres via Testcontainers): `apps/backend/jest.integration.config.js`,
  files `*.int.spec.ts`. Run: `pnpm --filter @repo/backend test:integration` (needs Docker).

Integration support files in `apps/backend/src/__tests__/integration/`:
- `globalSetup.ts` — provisions Postgres (Testcontainers, image `docker.arvancloud.ir/postgres:16-alpine`,
  override `INTEGRATION_PG_IMAGE`; `INTEGRATION_DB_MODE=service` reuses a CI service DB),
  runs `safety.ts` guards, publishes DB env, compiles TS→`dist` ONCE, sets `DISABLE_BACKGROUND_JOBS=true`
  and `SKIP_BOOTSTRAP_SEED=true`.
- `globalTeardown.ts` — stops the container.
- `setup.int.ts` — `setupFilesAfterEnv`; **mocks only external providers**: `redis`, `ioredis`,
  `axios`, `mellat-checkout`, `zarinpal-node-sdk`, and `../../utils/revalidate`. Persistence/business
  logic is REAL. `jest.setTimeout(240_000)`.
- `strapiInstance.ts` — `setupStrapi()` / `getStrapi()` / `teardownStrapi()`.
- `safety.ts` — aborts if `NODE_ENV≠test`, host/DB-name looks like staging/prod, or host isn't local/container.
- `factories/index.ts` — self-cleaning factories (registry-based; `JEST_TEST__` prefix; `cleanup()` in `afterEach`).
- `tier1/stock-and-reservation.int.spec.ts` — **14 tests, green** (atomic stock ops + reserve/consume/release/expiry).
- `README.md` — how-to-run + conventions.

**Fixes already landed in production code (verified, don't redo):**
- `src/index.ts` bootstrap: opt-in `SKIP_BOOTSTRAP_SEED` early-return that skips slow idempotent
  seeding/jobs in tests (default prod behavior unchanged).
- `src/utils/stockReservations.ts`: the reservation not-expired guard now binds a JS `Date`
  (`reserved_until >= ?`) instead of SQL `NOW()` — fixes a real timezone bug (pg `timestamp`
  without tz vs `timestamptz NOW()`). Unit test updated accordingly.

---

## 2. Harness mechanics you MUST respect

- **One Strapi boot per test file.** Booting takes ~4 min (mostly fresh-DB schema migration).
  Jest sandboxes each test file's `global`, so a function-level test needs the in-process `strapi`
  object and instances can't be shared across files. **Put all payment-idempotency specs in ONE
  file** with a single `beforeAll(setupStrapi)` / `afterAll(teardownStrapi)`. Do NOT add a new
  file per scenario.
- Run **in-band** (`--runInBand`, already in the script); config has `forceExit: true`.
- **Iterating is slow** (~4 min/run). Develop scenarios carefully; use `-t "<name>"` to run one
  test, but it still pays the full boot. Batch your assertions.
- **Mocks**: external gateways' SDKs are mocked statically in `setup.int.ts` as bare `jest.fn()`s.
  To control gateway *verify* results per test, prefer `jest.spyOn(strapi.service('api::payment-gateway.<x>'), 'verifyPayment')`
  (mock the Strapi service seam, not the SDK) — see §4. Confirm the exact service uid/method first.
- **TZ gotcha**: Strapi `datetime` → pg `timestamp` (no tz). When seeding times for assertions,
  remember the guard now binds JS Dates and is tz-consistent; avoid reintroducing `NOW()` comparisons.
- **Line numbers shift** when you edit; trust assertion *messages* over reported line numbers
  (ts-jest sourcemaps can be off by a comment line).
- Bootstrap still logs some noise (e.g. a revalidation-secret warning from dist-loaded code) — harmless.

---

## 3. The code under test

Primary: `apps/backend/src/api/order/controllers/helpers/payment.ts` → **`verifyPaymentHandler(strapi, ctx)`**
(exported ~line 419). It is large (~1500 lines) with **per-gateway branches**: ZarinPal, SamanKish,
SnappPay (and Mellat). READ IT FULLY before writing tests. Wiring: the public callback route is
`GET /orders/payment-callback` → controller `order.verifyPayment` (auth:false) — see
`src/api/order/routes/*` and `src/api/order/controllers/order.ts`.

Idempotency is **layered** — your tests should pin both layers:
1. **Order/reservation level**: `consumeOrderReservation(strapi, orderId, trx)` only transitions
   `Reserved→Consumed` once; duplicate calls are skipped (already proven in Tier 1). The handler
   guards with `if (orderMeta.ReservationStatus === "Reserved")` (~line 223) and skips when the
   order is already `Cancelled` / not in `Reserved|Consumed` (~line 1088).
2. **Transaction level**: the handler early-returns when the existing `contract_transaction.Status === "Success"`
   (~lines 600, 900) and dedupes by `external_id` (gateway authority / refNum / transactionId;
   ~lines 557, 889, 1276, 1364).

Supporting code (real, exercised): `utils/stockReservations.ts` (consume/release),
`api/cart/services/lib/stock.ts` (atomic ops), gateway services in
`api/payment-gateway/services/{zarinpal,mellat-v3,snappay}.ts`.

**Currency**: amounts are stored in **Toman** (contract.Amount, order fields) and converted to
**Rial ×10** for gateways/wallet. See memory `project_currency_units` / CLAUDE.md. Assert the stored
`contract_transaction.Amount` and the order/contract amounts in the right unit.

Persian gateway labels to assert where surfaced: زرین‌پال / بانک ملت / اسنپ! پی / سامان کیش / کیف پول
(verify the exact source-of-truth strings in code — don't hardcode from memory).

---

## 4. Scenarios to implement (one file, e.g. `tier1/payment-idempotency.int.spec.ts`)

Start with **ONE gateway end-to-end (ZarinPal is simplest)**, get it green, then generalize.

1. **Successful verification**: order in `Paying`/`Reserved` + contract + pending transaction →
   mock gateway verify = success → assert order `Started`, contract `Confirmed`, transaction
   `Success` with correct `GatewayRefId`/`Amount`, stock **consumed** (Count down, reservedCount→0).
2. **Duplicate callback (the headline)**: replay the same successful callback → assert NO double
   stock consumption, NO second `Success` transaction (dedup by external_id / `Status==="Success"`
   early-return), order stays `Started`. This is the core idempotency proof.
3. **Failed payment**: mock verify = failed → order `Cancelled`, stock **released**, transaction `Failed`.
4. **Cancelled / NOK callback**: order `Cancelled`, stock released.
5. **Amount + Rial/Toman correctness**: transaction Amount persisted in the expected unit.
6. (If cheap) repeat the success+duplicate pair for a second gateway to cover branch divergence.

For each: build a `ctx` mock (query/body carry the gateway's callback params — read the handler to
see which fields each branch reads: ZarinPal uses `Authority`/`Status`, Saman uses `State`/`ResNum`,
SnappPay uses a transactionId, etc.). Add a small `ctx` helper to `factories/` or a local helper.

**Factory gaps you'll likely add** (extend `factories/index.ts`):
- a `payment-gateway` entity so `contract_transaction.payment_gateway` can be linked;
- a higher-level `createPayableOrder()` that wires order(Paying/Reserved) + contract + reserved stock + (optional) pending transaction;
- a `ctx` builder for callback requests.

---

## 5. How to prove the tests have teeth (required)

After green, deliberately break an idempotency guard (e.g. remove the `contractTransaction.Status === "Success"`
early-return, or the `ReservationStatus === "Reserved"` check) and confirm the **duplicate-callback test FAILS**
(double consumption / duplicate Success). Then revert. This was done for Tier 1 (breaking the stock
WHERE-guard made the oversell test fail) and is the bar for "real QA value, not coverage decoration."
Verify `git diff` is clean on the production file afterward.

---

## 6. Commands

```bash
# Integration (needs Docker daemon; ~4 min boot):
pnpm --filter @repo/backend test:integration
# Single test (still pays boot):
cd apps/backend && pnpm exec jest --config jest.integration.config.js --runInBand --forceExit -t "duplicate callback"
# Unit layer must stay green:
pnpm --filter @repo/backend test:unit
```

Filter Strapi log noise when reading output:
`... 2>&1 | grep -vE "ioredis|NOAUTH|redis-parser|silentEmit|recoverFromFatalError" | grep -E "PASS|FAIL|Tests:|✕|Expected|Received"`

---

## 7. Rules / scope

- Mock ONLY external providers (gateways, SMS, CDN, redis/ioredis). Persistence, reservation,
  order, contract, and currency logic stay REAL.
- No sleeps; control time via injected clocks / seeded timestamps.
- Don't chase coverage numbers; assert real behavior and edge cases.
- Each test cleans up its own rows via the factory registry (`afterEach(() => f.cleanup())`).
- Keep unit tests fast and untouched unless a fix requires updating an assertion (then explain).
- **Out of scope for this increment**: CI wiring (deferred — runner has DinD/privileged, so
  Testcontainers will work; `test:ci` is still unit-only), Tier 2 (orders/discounts/shipping),
  Tier 3 (permissions/reporting). Don't start those until idempotency is green and reviewed.

---

## 8. Known pitfalls (learned the hard way)

- First boot is slow and Jest buffers output — don't assume a hang; give it ~4–5 min.
- The `redis` package AND `ioredis` both need mocking (rest-cache/strapi-plugin-redis use ioredis);
  already handled in `setup.int.ts` — keep it.
- `jest.mock("../../utils/revalidate")` keys by resolved path; the dist-loaded copy may still log a
  revalidation-secret warning — harmless.
- Strapi `datetime` is tz-naive; never compare against SQL `NOW()` (see the landed fix).
- There may be unrelated WIP failures in other unit specs from the user's in-progress feature work
  (e.g. cart/order handlers) — confirm whether a failure is yours before fixing; don't touch the
  user's WIP.

Relevant memory files (auto-loaded): `project_jest_integration_layer`, `project_stock_reservation`,
`project_currency_units`, `project_admin_audit_log`, `feedback_snappay_off_limits`
(note: SnappPay integration is off-limits to MODIFY — but writing tests against it is fine; do not
change SnappPay source).
