# Develop Infinitycolor locally

[فارسی](development.fa.md) · [Repository overview](../README.md)

## Tools and configuration

Use Node.js **20.19+ within 20.x**, Git, pnpm **10.28.2**, and Docker Compose.
The backend engine range ends at Node 20. On Windows use PowerShell and Docker
Desktop with WSL2. If working inside WSL2, keep the checkout and dependencies
there; reinstall when changing operating systems.

If Corepack is missing:

```bash
npm install --global corepack
corepack pnpm --version
```

Clone using GitLab's Clone button or authenticated `glab`. From the repository
root, in Bash or PowerShell:

```bash
glab repo clone bel4/infinity
cd infinity
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @repo/auth-core build
node scripts/setup-dev-env.mjs
node scripts/setup-dev-env.mjs --check
docker compose --env-file apps/backend/.env -f compose.dev.yml up -d
docker compose --env-file apps/backend/.env -f compose.dev.yml ps
```

Wait for PostgreSQL to become healthy. The helper creates missing
`apps/backend/.env` and web-app `.env.local` files, generates local secrets and
matching database passwords, and preserves existing files. `--check` checks file
presence only. Use the committed pnpm lockfile; do not run npm install in the
workspace. Optional provider credentials stay unset.

[Development Compose](../compose.dev.yml) starts this project's local storage:
PostgreSQL on **5432** and Redis on **6379**, bound to loopback.
A separate queue Redis also uses port 6381 with a noeviction policy.

Build [`@repo/auth-core`](../packages/auth-core) before startup: its package
exports compiled `dist`/`dist-cjs` files, and `dev` does not build them. Repeat
the package build after changing its source.

## Run and confirm startup

Terminal 1 at the repository root:

```bash
corepack pnpm --filter @repo/backend dev
```

For the repeatable demo, stop this backend and run the fixture below before creating a technical admin manually; then restart it. The generated technical admin signs in at http://localhost:1337/admin. In terminal 2 at the root:

```bash
corepack pnpm --filter @repo/frontend dev
```

Open http://localhost:1337/api/_health: expect `checks.db="ok"` and
`checks.redis="ok"`. Both dependency checks must be `ok`.
Open http://localhost:2888 and confirm the site loads without failed API
connections. The first startup may take time to compile.

## Auth and the other apps

Browsing the storefront can start with backend/frontend only. For password login,
custom admin or social content, prepare the Auth schema on the same local
`infinity_local` database first:

```bash
node --env-file=apps/auth/.env.local apps/auth/scripts/apply-migration.mjs
```

The generated `AUTH_MIGRATION_DATABASE_URL` uses the local database owner;
`AUTH_DATABASE_URL` uses the separate `infinity_auth_app` role. The script creates
that role/schema and applies additive migrations. Its URL-to-filesystem path
handling can reject native Windows drive paths: run this stack entirely in WSL2
if that occurs, with dependencies installed inside WSL2.

In separate terminals at the repository root:

```bash
corepack pnpm --filter @repo/auth dev
corepack pnpm --filter @repo/admin dev
corepack pnpm --filter @repo/social dev
```

| App | Address |
| --- | --- |
| Auth | http://localhost:2889 |
| Custom admin | http://localhost:2891 |
| Social | http://localhost:2890 |

Keep `AUTH_STRAPI_BRIDGE_SECRET` synchronized between backend/Auth and use the
configured `localhost` origins consistently. Passwords and business roles belong
to Strapi; Auth provides linked identities and sessions. See
[architecture](auth/architecture.md) and [operations](auth/operations.md).

## First use and local fixtures

Follow “Repeatable local demo” below for synthetic catalog/account fixtures. Stop the backend before seeding and keep local storage running.

The Strapi technical-admin login is separate from the storefront login. Legacy `seed:admin` and WooCommerce importers are not onboarding commands. Start with the helper’s synthetic products; payment and SMS require separately reviewed development-provider setup.

## Source map and affected checks

| Work | Source | Checks |
| --- | --- | --- |
| Storefront and account UI | [Frontend source](../apps/frontend/src) | Frontend lint, types, tests, build; affected browser journey |
| Stock/catalog/orders | [Backend APIs](../apps/backend/src/api) | Backend types, unit tests, build; local API |
| Roles/bootstrap | [Backend startup](../apps/backend/src/index.ts) | Backend checks plus allowed/denied actions with local users |
| Local service setup | [Helper](../scripts/setup-dev-env.mjs), [Compose](../compose.dev.yml) | Setup presence, storage health and API health |

```bash
corepack pnpm --filter @repo/frontend lint
corepack pnpm --filter @repo/frontend check-types
corepack pnpm --filter @repo/frontend test --runInBand
corepack pnpm --filter @repo/frontend build
corepack pnpm --filter @repo/backend check-types
corepack pnpm --filter @repo/backend test --runInBand
corepack pnpm --filter @repo/backend build
```

Use the affected package checks; root `lint`, `check-types`, `test`, and `build`
are wider Turbo checks. The [focused unit test](../apps/backend/src/api/cart/services/lib/__tests__/stock-available.spec.ts) above is available
before catalog/account fixtures. Real database, browser, import and provider
suites need their own isolated fixture/target; they are not first-start commands.

## Stop, restart, and troubleshoot

Stop each app with Ctrl+C. Stop storage while retaining data:

```bash
docker compose --env-file apps/backend/.env -f compose.dev.yml down
```

To resume, repeat the storage `up -d`/`ps` commands, wait for health, then restart
the app terminals. Restart apps after editing environment settings. Do not use
`down -v` as a routine repair.

- **Database/cache connection fails:** check Compose `ps` and
  `docker compose --env-file apps/backend/.env -f compose.dev.yml logs --tail=80 postgres redis`.
  Compare backend `DATABASE_PORT`/`REDIS_URL` with 5432/6379.
- **Database password rejected:** existing volumes keep their initial password;
  the setup helper preserves existing local files. Reconcile that local pair;
  editing `.env` alone does not rotate the database password.
- **Storefront talks to the wrong API:** use
  `NEXT_PUBLIC_API_BASE_URL=http://localhost:1337/api` and the matching local
  `STRAPI_INTERNAL_URL`. `.env.local` is the local frontend override. A warning
  that legacy `main.env` is absent is not a request for production settings.
- **Catalog is empty/login is rejected:** check the fixture prerequisites above.
  A fresh technical-admin account does not satisfy business-user authentication.
- **Port collision:** 1337/2888 are shared defaults across commerce repos. Run one
  stack at a time or deliberately update each service origin and port together;
  do not stop another project's processes blindly.
- **Missing compiled @repo/auth-core module:** repeat the package build above
  after installation or shared-package changes, then restart the app.
- **Corepack shim cannot be written:** use `corepack pnpm` directly. For install
  failures, check Node/pnpm versions before changing the committed lockfile.

Use the [GitLab guide](gitlab-workflow.md) for branches and merge requests.

## Local doctor

From the repo root, before starting services:

```bash
node scripts/dev-doctor.mjs --before-start
```

After starting the services described in this guide:

```bash
node scripts/dev-doctor.mjs --running
```

The doctor reads the explicit local env files, validates local targets and tools, and checks ports. Before startup, required ports should be free. Running checks require the documented storage/API/web processes; optional apps are not included. Exit codes: `0` passed, `2` tools or configuration need attention, `3` a port or service does not match the selected state. It prints key names and versions, never secret values, and does not install packages, change configuration, start/stop services, follow redirects, or call providers. Follow the reported failed check, then rerun.

## Repeatable local demo

Keep local storage running and **stop the backend** before this step. From the repo root:

```bash
node scripts/seed-local-demo.mjs
node scripts/seed-local-demo.mjs --apply
```

The first command validates the local target and prints a plan. `--apply` starts this repo’s backend on its own exact loopback port with only validated local settings, seeds through authenticated CMS interfaces, then stops that owned process. It refuses an occupied normal backend port, remote/production database URLs, unsafe SQLite paths and ambient database overrides. It does not connect to an already-running API or use an importer.

On an empty CMS, it registers `local-demo-infinity@example.test` as the first **local technical admin** with a generated password. The actual email/password stay in ignored `.local-demo-credentials.json`; open that file locally to sign in at `/admin`, never paste it into an issue/MR or commit it. If a local admin already exists, create that reserved synthetic account through Strapi’s admin Users page and put its email/password in that same private file. The helper never resets passwords, changes existing roles or reactivates accounts.

The fixture contains category `local-demo-catalog`, product slug `local-demo-product`, SKU `LOCAL-DEMO-001`, price `250000` and stock `12`, with a tracked synthetic image. Restart the normal backend/storefront and open the product. Reruns reuse stable entries, stock and image without overwriting local edits; a reserved-key collision stops with an explanation. This is catalog/cart browsing data, not a live order/payment fixture.

The same helper creates one reserved synthetic storefront customer in the existing `customer` role. Open the private file’s `customer` object for its phone/password and use the storefront’s normal password-login form. The helper checks the stored password hash, linked profile and real login; reruns preserve the existing password and role. It does not send OTP/SMS or exercise payments.

Central Auth login needs backend local `BETTER_AUTH_BRIDGE_ENABLED=true` and `LEGACY_AUTH_JWT_ISSUANCE_ENABLED=false`. New examples use these values; reconcile these two flags in existing local files, then restart the backend.

On the first empty business-user database only, the helper creates a separate reserved `Superadmin` anchor before the customer. Its phone/password are in `businessAdmin`; use the custom admin’s normal password login. This source-required anchor keeps later backend startup valid. An existing unowned business store or identity collision stops the helper. Reruns verify the actual admin role and preserve any role/password changes; they never restore access or change role permissions. The central Auth frontend still needs its documented local Auth service.

The fixture requires the documented local PostgreSQL user `infinity`, `public` schema and matching explicit database fields/URL credentials. These are local target checks; they do not attest a separately running production stack.

The guarded CMS demo helper applies changes only on Linux or WSL2, where it proves the listening and accepted socket belongs to its own backend process group. On Windows, run this demo step inside WSL2 with Node and dependencies installed there. Normal Windows startup commands above stay available. The helper refuses native Windows/macOS before spawning or creating credentials; native Windows listener ownership has not been runtime-tested.
