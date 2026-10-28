# E2E in CI

## The flow

```
dev push
  tests ║ image builds ──► e2e:admin:smoke (throwaway stack, Chromium)
                         └► staging:release  ── holds resource_group infinity-staging until done ──┐
                              child pipeline (.gitlab/ci/staging-release.yml)                         │
                              deploy:staging → verify:staging:ready ─┬ verify:admin:staging          │
                                                                     ├ e2e:staging:critical  (gate) │
                                                                     └ e2e:staging:purchase (warn)  │
                            ◄─────────────────────────────────────────────────────────────────────────┘
main push
  tests ║ image builds ║ promote:staging-gate ──► production:deploy (manual) ──► verify:admin:production
                                                                              ├ verify:production:health
                                                                              └ postdeploy:edge-check
nightly (schedule on dev, E2E_SCHEDULE=staging-nightly)
  the test jobs ║ staging:regression (all tags × 3 devices, 2 shards, merged report) ║ e2e:admin:nightly
```

**Why a child pipeline.** A resource group is taken per job, so with separate jobs a newer pipeline
could redeploy staging between this pipeline's deploy and its E2E (the `infinity-staging` group is
`newest_ready_first`, which favours exactly that). The trigger jobs hold the group with
`strategy: mirror` until the whole child pipeline finishes — GitLab's documented pipeline-level
concurrency control — so what the tests see is what this pipeline deployed. Jobs inside the child never
take `infinity-staging` themselves (that would deadlock); `deploy:staging` uses `infinity-staging-deploy`
only to serialise Environment Rollback re-runs.

**Readiness.** `verify:staging:ready` (`scripts/ci/wait-ready.mjs`) polls the public api, auth, admin
and storefront health with bounded backoff (5 min) and, for the apps this commit rebuilt (decided like
the playbook: does `<repo>:<sha>` exist in the registry), requires the storefront's `data-dpl-id` and the
admin's `release` to be this commit. Backend and auth expose no release id; the lock covers them.

## What blocks production

`production:deploy` needs `promote:staging-gate`, which passes only if a dev commit with **exactly the
same source tree** as main's HEAD passed `e2e:staging:critical` (recorded in the package registry as
`staging-verified/<sha>/attestation.json` by `scripts/ci/staging-attestation.mjs`). Main receives dev by
merge or fast-forward, so the trees match. Frontend, admin and auth images bake their public origins in,
so their staging and production images differ by design; the source tree is what was verified. The
backend image is the same `infinity-backend:<sha>` in both.

- The dev pipeline still running? The gate fails naming the dev commit; retry it once
  `e2e:staging:critical` has passed.
- A hotfix committed straight to main has no verified tree. It passes only with a recorded reason:
  `git push -o ci.variable="STAGING_GATE_OVERRIDE=<reason>"`, or a `Staging-Gate-Override: <reason>`
  trailer on the commit. The job log prints the reason.
- Environment > Rollback re-runs `production:deploy` alone and is never blocked.

Payment journeys (`@purchase`) never block: a provider sandbox outage must not stop a release.

## Production

Nothing Playwright-based runs against production, and the E2E fixture API can only exist where
`E2E_FIXTURES_ENABLED=true` (staging's stack; a static rule forbids it in every production file). After a
release, `verify:production:health` makes read-only GETs (api with DB/Redis, auth, admin, storefront).
The staging config's global setup refuses any origin that is not staging, loopback or explicitly
allowed, and always refuses production hosts.

## How the jobs reach the fixture API

No secret is involved. Each staging E2E job asks GitLab for an ID token (`id_tokens: E2E_FIXTURES_ID_TOKEN`,
audience `https://api.staging.infinitycolor.co`), a short-lived RS256 JWT that git.alpagency.net signs and
that expires with the job (`timeout: 30m`). The staging backend verifies it against
`https://git.alpagency.net/oauth/discovery/keys` and lets the job in only if `project_path` is
`bel4/infinity`, `ref_protected` is `"true"`, `environment` is `staging` and `ref` is `dev`
(`E2E_FIXTURES_OIDC_*` in `deploy/infinity-staging/stack.yml`). Anything else gets the same bare 404 as a
backend without fixtures.

When the API refuses a job, global setup has already printed the token's claims (never the token) and the
api logs the failed check: `[e2e-fixture] refused a GitLab ID token: <claim>`.

## Variables

| Variable | Where | Notes |
|---|---|---|
| `E2E_SCHEDULE=staging-nightly` | the dev pipeline schedule | turns on `staging:regression` and `e2e:admin:nightly` |
| `STAGING_GATE_OVERRIDE` | push option on a main hotfix | the reason is printed by the gate |

Existing staging deploy variables (`DEPLOY_*`, `SSH_KNOWN_HOSTS`) are unchanged. There is no fixture token
variable in CI.

## Setup

1. Create the nightly schedule on `dev` with variable `E2E_SCHEDULE=staging-nightly`.
2. Staging must offer an active Wallet payment gateway (for the wallet purchase) and the ZarinPal sandbox
   merchant (`ZARINPAL_MERCHANT_ID` all zeros, `ZARINPAL_SANDBOX=true`) for the ZarinPal purchase; the
   `@purchase` tests say which is missing.
3. Optional, only to run the suite against staging from a laptop: `sudo bash
   deploy/infinity-staging/enable-e2e-fixtures.sh` on alp-services adds a static `E2E_FIXTURES_TOKEN` to
   `/srv/secrets/infinity-staging/backend.env` (read at the next staging deploy) and prints it.

## Reports

- JUnit for every E2E job (`apps/e2e/reports/*.xml`) in the pipeline's Tests tab (the child pipeline's,
  for staging jobs).
- HTML report, traces (first failure of each test), screenshots on failure:
  `apps/e2e/playwright-report/staging/` and `apps/e2e/test-results/staging/`; the nightly shards upload
  blobs and `e2e:staging:report` merges them into one HTML report.
- `reports/staging-ready.json` / `reports/production-ready.json`: what readiness saw.
- Everything is scrubbed before upload (cookies, bearer tokens, URL queries, configured secrets; trace
  network logs removed) and kept for a week. `.auth/` is never uploaded.

## Runtime

Before (pipelines 1160/1169): no staging E2E; the admin smoke ran three times per dev push (Chromium,
Firefox, WebKit) at 10.5–12.7 min each (~33 runner-minutes), of which ~1.5 min was tests and the rest
standing up the throwaway stack. The dev critical path was 27.9 min (backend build 9.8 → admin smoke 11
→ deploy 6.6).

After: one Chromium admin smoke per push (~11 min; Firefox and WebKit move to the nightly run), then the
staging lifecycle: deploy (unchanged), readiness (seconds when healthy), and the critical and purchase
jobs side by side. Locally the whole staging suite (36 tests, 3 devices, 2 workers) ran in 2.3 min and
the `@critical` journey takes ~10 s per device, so the gate adds roughly install (~1 min) + tests (~1
min) to the release; measured CI numbers come from the first pipelines.
