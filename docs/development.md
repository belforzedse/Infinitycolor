# Develop Infinitycolor locally

[Repository overview](../README.md)

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

From the repository root in Bash or PowerShell:

```bash
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
A separate queue Redis uses port 6381 with a noeviction policy. If these ports are occupied, set `DATABASE_PORT`, `LOCAL_REDIS_PORT`, and `QUEUE_REDIS_PORT` in the backend environment file and use matching ports in the Redis URLs and any local Auth database URLs.

Build [`@repo/auth-core`](../packages/auth-core) before startup: its package
exports compiled `dist`/`dist-cjs` files, and `dev` does not build them. Repeat
the package build after changing its source.

## Run and confirm startup

Terminal 1 at the repository root:

```bash
corepack pnpm --filter @repo/backend dev
```

Create a technical admin at http://localhost:1337/admin. In terminal 2 at the root:

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
to Strapi. Auth provides linked identities and sessions. See the generated
environment templates for the available configuration.

## First use and local fixtures

The Strapi technical-admin login is separate from the storefront login. Use your own development catalog. Payment and SMS require separate development-provider setup.

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

Use affected package checks. Root Turbo commands cover the wider workspace. The [focused unit test](../apps/backend/src/api/cart/services/lib/__tests__/stock-available.spec.ts) above is available
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
