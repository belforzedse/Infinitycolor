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

Create the local Strapi technical admin at http://localhost:1337/admin after the
backend starts. In terminal 2 at the root:

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

A technical-admin account lets you inspect the local Content Manager. It is not
a storefront customer or business-admin login. Fresh startup provisions business
roles and Public read permissions in [backend bootstrap](../apps/backend/src/index.ts),
but does not provide a complete catalog or login fixture.

Before sample data arrives, check these concrete results:

1. Strapi admin opens and Product/Variation/Stock collections are available.
2. `http://localhost:1337/api/products` returns JSON; an empty catalog is valid.
   A 403 needs investigation of startup/permission errors, not a blanket grant.
3. The storefront renders and the unit test below can exercise reserved versus available stock calculations
   without an external provider or seeded database.

```bash
corepack pnpm --filter @repo/backend test:unit --runInBand src/api/cart/services/lib/__tests__/stock-available.spec.ts
```

There is no maintained general-purpose demo seed. `seed:e2e` is a test-only
fixture with teardown/target guards; it is not the everyday onboarding seed.
The legacy `seed:admin` asks for a Master API token and assumes local-user role
ID 2; it does not establish a current custom-admin account. Do not run either
against your working database to guess your way into a login.

Request a **local-only fixture** from the maintainer containing:

- One category, one `Active` product with a unique slug and image, one linked
  variation with unique SKU and price, and linked stock with `Count > 0` and
  `reservedCount = 0`. Include the product URL/slug so you can find it.
- The local settings/navigation relations needed to display that product. Verify
  that Public product/category read permissions match bootstrap.
- For cart/checkout work, a synthetic customer, address, province/city and local
  shipping data; any payment/SMS test configuration must be stated separately.

Once supplied, open the product, select its variation, add it to the cart, and
confirm the displayed price and available stock match the fixture.

For account/admin tasks the maintainer must additionally provide a synthetic,
verified and active Strapi Users & Permissions customer and a separate staff
user in the specific role required by the task, with password-login credentials
and working identity links through local Auth. Start Auth before testing the
storefront login or custom admin at port 2891. SMS and gateway journeys need
explicit development provider configuration; none is supplied by setup.

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
