# Backend integration test layer

Real-DB integration tests for business-critical backend logic. These boot a
**real Strapi** against a **real, disposable Postgres** (same engine as
production) so persistence, relations, transactions and the Postgres-specific
raw SQL (`... RETURNING ...`) are actually exercised — unlike the fast mocked
unit layer (`jest.config.js`), which stubs the `strapi` global.

## Run

```bash
# Requires a running Docker daemon (local default: postgres:16-alpine).
# CI sets INTEGRATION_PG_IMAGE=.../postgres:17-alpine to match staging.
pnpm --filter @repo/backend test:integration
```

- Unit layer (mocked, fast, no Docker): `pnpm --filter @repo/backend test:unit`
- Integration layer (real DB): `pnpm --filter @repo/backend test:integration`

## How it works

- `globalSetup.ts` — forces a safe test env, provisions Postgres (Testcontainers
  by default; set `INTEGRATION_DB_MODE=service` to reuse a CI `services:`
  Postgres), runs the `safety.ts` guards, publishes the connection via
  `process.env` + a temp file, and compiles the TS project to `dist` **once**.
- `setup.int.ts` — `setupFilesAfterEnv`; mocks ONLY external providers (Redis,
  ioredis, axios, payment SDKs, CDN/revalidation). Persistence/business logic is real.
- `strapiInstance.ts` — `setupStrapi()` / `teardownStrapi()` boot/destroy a real
  Strapi from the prebuilt `dist`. Booting is expensive (schema migration +
  bootstrap seeding ≈ 4–5 min on cold Docker), and a function-level test needs
  the in-process `strapi` object, so **group related specs into one file** to
  share a single boot.
- `factories/` — self-cleaning factories over the real query engine. Every test
  creates its own data and removes only its own rows in `afterEach`; all
  test-owned strings carry the `JEST_TEST__` prefix.

## Safety

`safety.ts` aborts before connecting if `NODE_ENV !== "test"`, if the DB host
looks like a real environment (`infinity-postgres`, `rgbgroup`, …), if the DB
name looks real (`prod`/`dev`/`staging`/…), or if the host is not local/container.
The disposable container is the cleanup — no real database is ever mutated.

## Conventions

- File suffix: `*.int.spec.ts` (excluded from the unit layer).
- Run in-band (`--runInBand`): one Strapi instance, one DB.
- Time-based logic uses injected clocks (e.g. `runExpireStockReservationsTick({ now })`),
  never sleeps. (Strapi `datetime` → pg `timestamp` without tz; the reservation
  guard now binds a JS `Date` instead of SQL `NOW()`, so small expiry deltas are
  classified deterministically regardless of session timezone.)
