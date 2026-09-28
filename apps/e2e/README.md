# Infinitycolor E2E

Browser tests in three groups, each with its own Playwright config. What runs where in CI, what
blocks production and which variables are needed: [CI-E2E.md](CI-E2E.md).

| Suite | Config | Targets | Runs in CI |
|---|---|---|---|
| **Staging journeys** | `staging.playwright.config.ts` (`tests/staging`) | the deployed staging environment | every dev push, nightly, on demand |
| **Admin** | `admin.playwright.config.ts` (`tests/super-admin`) | a throwaway stack the job builds | `@smoke` on Chromium every dev push; everything nightly |
| **Isolated storefront & feature suites** | `playwright.config.ts`, `adaptive`, `static-parity`, `forced-low`, `instant`, `analytics`, `stories`, `defects` | a local or disposable stack | no (developer tools) |

## Staging journeys

Real shopper behaviour against staging, with test data that each test owns.

| Tag | What | CI |
|---|---|---|
| `@critical` | Home and a category listing render; the checkout journey: a guest opens a product from its listing, picks colour and size, adds it, the cart shows exactly that variant and price, checkout sends them to central sign-in and back, the cart line followed them, they pick an address and a delivery method, a payment method is offered and the on-screen total equals the server's `POST /carts/quote`. No order is placed. | Blocks production (desktop + Android Chromium) |
| `@purchase` | A complete order paid from wallet credit (order, items, status, gateway, cart, stock and wallet checked afterwards), and the ZarinPal **sandbox** round trip: pay (settled through our callback) and cancel (order cancelled, stock back). | Every dev push, never blocks |
| `@regression` | Cart quantity/removal persisted server-side; an out-of-stock variant cannot be chosen; checkout without a delivery method is refused and places no order; order history lists an order; a product that leaves the store while open or in the cart is refused and cannot be paid for. | Nightly and on demand, three devices |

Devices: `desktop-chromium`, `mobile-chromium` (Pixel 7) and `mobile-webkit` (iPhone 14). Most shoppers
are on phones, many inside Instagram's in-app browser (Chromium on Android, WebKit on iOS).

### Test data: the fixture API

Staging is a shared database, so the suite never uses whatever happens to be there. The backend's
fixture API (`apps/backend/src/api/e2e-fixture`) gives every Playwright worker a **slot** (0–63):

- one shopper (`+98 900 000 3000 + slot`, name "E2E Shopper Sxx", a fresh random password on every call);
- one product of its own (`e2e-fixture-product-sxx`, category `e2e-fixture`) with an in-stock and an
  out-of-stock variant, published through the normal publication command;
- one address in a real shipping city, and a wallet balance the test asks for.

Each test provisions its slot at the start (unfinished checkouts cancelled with their stock and wallet
holds released, cart emptied, stock topped up) and cleans it up at the end. Workers therefore never share
a cart, a wallet or a stock row. Jobs that run at the same time use separate slot ranges (`E2E_SLOT_BASE`).

The API touches only rows it owns (`external_source = "e2e-fixture"`, accounts on `@e2e-fixture.invalid`),
refuses to adopt any other account, and answers 404 unless the backend has `E2E_FIXTURES_ENABLED=true`
**and** an `E2E_FIXTURES_TOKEN` of 32+ characters, and its storefront/public URL is not a production
host. Only staging sets these. Wherever fixtures are enabled, no SMS (customer or staff alert) is ever sent
about a fixture shopper.

### Payments

- Nothing that blocks a release pays: the `@critical` journey stops at the payment step.
- Wallet purchases settle entirely inside Infinity (no provider involved).
- ZarinPal runs against its official sandbox. The test fails if the redirect goes anywhere but
  `sandbox.zarinpal.com`, and every run carries a tripwire that aborts and fails any request to a
  real-money gateway (`payment.zarinpal.com`, `*.shaparak.ir`, SnappPay).
- Real SMS is never involved: shoppers sign in through the central auth service's password endpoint.

### Running it

Against staging (needs the staging token; ask for it, never commit it):

```bash
cd apps/e2e
E2E_FIXTURES_TOKEN=… pnpm e2e:staging:critical      # the gate
E2E_FIXTURES_TOKEN=… pnpm e2e:staging                # everything, all devices
E2E_FIXTURES_TOKEN=… pnpm e2e:staging --grep @regression --project mobile-webkit
```

Local runs default to slots 48+ so they don't collide with CI (`E2E_SLOT_BASE` to change).

Against a local stack: set `E2E_BASE_URL`, `E2E_API_URL`, `E2E_AUTH_ORIGIN`, start the backend with
`E2E_FIXTURES_ENABLED=true` and a token, and seed a checkout baseline (`pnpm --filter @repo/backend seed:e2e`
creates shipping methods and the Wallet/ZarinPal gateway rows). Loopback and `*.test` hosts are allowed;
other hosts must be named in `E2E_ALLOW_TARGET_HOSTS`, and production hosts are always refused. Note that
the auth service only returns a shopper to an `https:` page after sign-in, so on a plain-http stack the
journey lands on `/account` instead of `/checkout`.

### Writing tests

- Import `test`/`expect` from `fixtures/staging.ts`; use the `shopper` fixture for data and
  `fixtureApi` for server-side facts a shopper cannot see (stock).
- Navigate with `gotoStorefront(page, path)`: it waits for `<html data-app-ready="true">`, which the
  storefront sets once it has hydrated and resolved the session. A tap before that can be dropped.
- Prefer roles and labels (`getByRole("button", { name: "افزودن به سبد خرید" })`); existing `data-testid`
  contracts where there is no user-facing one. No `waitForTimeout`, no `networkidle`, no retry loops
  around clicks.
- Verify outcomes through the shopper's own API (`shopperApi(page)`), not by trusting the page.
- Use `test.step` for business steps; tag with `{ tag: "@critical" | "@purchase" | "@regression" }`.

## Admin suite

CRUD and permission tests need every staff role seeded and create and delete data, so they run against a
throwaway stack (Postgres, Redis and the backend image of the commit as services; central auth and the
storefront from source; an admin production build), never against staging or production. See the
`.e2e_admin_base` job for the exact environment.

## Isolated storefront and feature suites

`playwright.config.ts` and the feature configs run against a local stack seeded by
`pnpm --filter @repo/backend seed:e2e` (refuses any database whose name is not local/test/e2e). Global
setup waits for the backend, seeds, and signs each seeded role into central auth, writing cookies to
`.auth/` (git-ignored, never uploaded). Useful defaults:

```bash
E2E_BASE_URL=http://localhost:2888 E2E_AUTH_ORIGIN=http://localhost:2889 \
E2E_API_URL=http://127.0.0.1:1337/api pnpm e2e:smoke
```

These suites share one seeded customer, so they run with one worker; the fixture API above is the way
to give them isolated data when they are brought into CI.

## Output

- `reports/*.xml` (staging JUnit), `e2e-results.xml`, `e2e-admin-results.xml`
- `playwright-report/`, `test-results/`, `blob-report/` (sharded CI runs)

CI scrubs traces and reports (`scripts/sanitize-admin-artifacts.mjs`) before uploading them and never
uploads `.auth/`. Do not put tokens, cookies or `.env` files anywhere Playwright writes.
