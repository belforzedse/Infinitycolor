# E2E CI Wiring

## Local Service Contract

Run Playwright from `apps/e2e`. The suite expects:

- Frontend: `E2E_BASE_URL`, default `http://localhost:2888`
- Backend API: `E2E_API_URL`, default `http://localhost:1337/api`
- Backend health: `E2E_API_HEALTH_URL`, default `http://localhost:1337/_health`
- Redis and Postgres available before Strapi starts
- CI-safe Zarinpal: start the local backend with
  `ZARINPAL_E2E_DETERMINISTIC=true`, `ZARINPAL_MERCHANT_ID=00000000-0000-0000-0000-000000000000`,
  `ZARINPAL_SANDBOX=true`, `ZARINPAL_CALLBACK_URL=http://localhost:1337/api/orders/payment-callback`,
  `ZARINPAL_CURRENCY=IRR`, and `URL=http://localhost:1337`

`global-setup.ts` waits for backend health, runs `pnpm --filter @repo/backend seed:e2e`,
and writes role auth states under `.auth/`.

## Recommended CI Jobs

Use a clean isolated DB and archive only report outputs:

```powershell
cd apps/e2e
pnpm run e2e:smoke
pnpm run e2e:regression
pnpm run e2e:payment
pnpm run e2e:admin
pnpm run e2e:permissions
```

Artifacts:

- `apps/e2e/e2e-results.xml`
- `apps/e2e/playwright-report/`
- `apps/e2e/test-results/`

Do not artifact `.auth/`; it contains bearer tokens and is already gitignored.

## Payment Live

`@payment-live` is manual-only and targets staging:

```powershell
cd apps/e2e
$env:E2E_BASE_URL="https://staging.infinitycolor.co"
$env:E2E_API_URL="https://api.staging.infinitycolor.co/api"
$env:E2E_AUTH_MODE="login"
$env:E2E_SEED_MODE="skip"
pnpm run e2e:payment:live
```

The staging backend must already have:

- `ZARINPAL_MERCHANT_ID=00000000-0000-0000-0000-000000000000`
- `ZARINPAL_SANDBOX=true`
- a valid Zarinpal callback URL

Live tests create test orders on staging as the seeded E2E customer. Re-seed staging
fixtures when the dedicated payment variation stock needs resetting.
