# Local development on Linux and Windows

[فارسی](development.fa.md)

## Tools

Install Node.js 20.19 or later within 20.x (the backend engine range), Git, and Docker Compose. On Windows use PowerShell and Docker
Desktop with its WSL2 backend. WSL2 can also run the Linux instructions; keep a
checkout and its `node_modules` in one OS filesystem and install dependencies
again when switching operating systems.

This repository uses **pnpm 10.28.2**, pinned by `packageManager` in the root
manifest. npm is used only to install Corepack when it is missing; do not run
`npm install` in the workspace or create a second lockfile.

```bash
npm install --global corepack
corepack pnpm --version
```

These commands also work in PowerShell. `corepack enable pnpm` is optional; if
Windows denies writing a shim beside Node, use `corepack pnpm` directly.

## Clone and install

Authenticate as described in [the GitLab guide](gitlab-workflow.md), then run in
either Bash or PowerShell:

```bash
glab repo clone bel4/infinity
cd infinity
corepack pnpm install --frozen-lockfile
node scripts/setup-dev-env.mjs
```

The setup helper creates missing ignored local files from the committed
examples, generates fresh local secrets, and preserves every existing local
file. It prints paths, never secret values. To check for missing files:

```bash
node scripts/setup-dev-env.mjs --check
```

The helper writes `apps/backend/.env` and web-app `.env.local` files. Required
local Strapi secrets and the database password are generated. Optional provider
credentials remain unset; no production env file is needed.

```bash
docker compose --env-file apps/backend/.env -f compose.dev.yml up -d
```

This Compose file starts only the project's local database/cache services. It
does not start app images or deploy anything.

The Auth examples distinguish the migration connection from the application
role. On a fresh local database, initialize the additive auth schema before
starting Auth:

```bash
node --env-file=apps/auth/.env.local apps/auth/scripts/apply-migration.mjs
```

That command uses only the generated local migration URL. Its existing
migration script uses a URL pathname as a filesystem path; use WSL2 for this
step on Windows if a native drive path is rejected. The complete local stack
can run inside WSL2 without mixing Windows dependencies.

The shared `AUTH_STRAPI_BRIDGE_SECRET` in backend and Auth must match. See the
[auth architecture](auth/architecture.md) and [operations guide](auth/operations.md).
The development Compose file includes a separate noeviction Redis for BullMQ.


## Start

In the first terminal, start the backend:

```bash
corepack pnpm --filter @repo/backend dev
```

Once Strapi is ready, open a second terminal in the repository root:

```bash
corepack pnpm --filter @repo/frontend dev
```

Create the local Strapi technical admin at `/admin`; configure local content
permissions before expecting a populated storefront. Provider-dependent
checkout/SMS flows need deliberately supplied development credentials.

For Auth, custom admin, and social content, use separate terminals after the
auth migration:

```bash
corepack pnpm --filter @repo/auth dev
corepack pnpm --filter @repo/admin dev
corepack pnpm --filter @repo/social dev
```


| App | Local address |
| --- | --- |
| Storefront | http://localhost:2888 |
| Strapi | http://localhost:1337/admin |
| Auth | http://localhost:2889 |
| Custom admin | http://localhost:2891 |
| Social | http://localhost:2890 |


## Checks

```bash
corepack pnpm lint
corepack pnpm check-types
corepack pnpm test
corepack pnpm build
```

Run affected packages during development and the relevant wider checks before a
merge. Dependency updates should update the pnpm lockfile with the pinned
version; a frozen install is the clean-clone check.

## Stop and troubleshoot

Stop foreground app processes with Ctrl+C. Use `docker compose --env-file apps/backend/.env -f compose.dev.yml down` for local storage.
Keep database volumes unless you deliberately want to reset local data.

If a port is occupied, identify the owning project before stopping its process.
An installation error is different from a missing local service: check Node and
pnpm versions first, then Compose health and the application's configured URL.
Configuration files are UTF-8 `KEY=value` files; do not paste PowerShell variable
syntax into `.env` files. Keep private credentials out of `NEXT_PUBLIC_*` values.
