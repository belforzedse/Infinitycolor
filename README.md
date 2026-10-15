<p align="center">
  <img src="docs/branding/logo.png" alt="Infinitycolor" width="220">
</p>

# Infinitycolor

Infinitycolor is a Persian commerce platform. Next.js serves the storefront;
Strapi owns catalog, accounts, orders, and payment integrations.

![Infinitycolor brand artwork](docs/branding/cover.jpg)

## First local start

[راهنمای کامل فارسی](docs/development.fa.md) · [Complete English guide](docs/development.md)

Use Node.js 20.19+ within 20.x, pnpm 10.28.2 through Corepack, and Docker Compose.
From the repository root, in Bash or PowerShell:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @repo/auth-core build
node scripts/setup-dev-env.mjs
docker compose --env-file apps/backend/.env -f compose.dev.yml up -d
docker compose --env-file apps/backend/.env -f compose.dev.yml ps
```

Wait for PostgreSQL to be healthy. Start the backend, keeping the terminal open:

```bash
corepack pnpm --filter @repo/backend dev
```

In another terminal at the root:

```bash
corepack pnpm --filter @repo/frontend dev
```

Create the local technical admin at http://localhost:1337/admin. Open
http://localhost:1337/api/_health and confirm database/cache checks, then open
http://localhost:2888. Local PostgreSQL is on 5432; Redis is on 6379.

A fresh database has no complete demo catalog or storefront login account.
The [first-use checklist](docs/development.md#first-use-and-local-fixtures) gives
API/unit-test checks you can do immediately and the exact local catalog/account
fixture to request from the maintainer. Strapi's technical admin is a separate
account from a customer or store administrator.

Authentication, custom admin, and social content need the Auth migration and
matching service secrets. Follow the [Auth setup](docs/development.md#auth-and-the-other-apps)
before starting those apps.

## Where to work

- [`apps/frontend`](apps/frontend) — storefront, port 2888
- [`apps/backend`](apps/backend) — Strapi commerce API, port 1337
- [`apps/auth`](apps/auth) — central session runtime, port 2889
- [`apps/admin`](apps/admin) — custom admin, port 2891
- [`apps/social`](apps/social) — social app, port 2890
- [`apps/e2e`](apps/e2e) — Playwright coverage
- [`packages`](packages) — shared contracts and UI

## Checks

```bash
corepack pnpm --filter @repo/frontend lint
corepack pnpm --filter @repo/frontend check-types
corepack pnpm --filter @repo/frontend test --runInBand
corepack pnpm --filter @repo/backend check-types
corepack pnpm --filter @repo/backend test --runInBand
```

Run affected checks and builds as described in the guide. Keep real payment/SMS
credentials out of the first local run.

## Collaboration and releases

- [GitLab workflow](docs/gitlab-workflow.md) · [راهنمای GitLab](docs/gitlab-workflow.fa.md)
- [GitLab CI](.gitlab-ci.yml) · [Production release guide](deploy/production/README.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)
- [Issues](https://git.alpagency.net/bel4/infinity/-/issues) · [Merge requests](https://git.alpagency.net/bel4/infinity/-/merge_requests)

[MIT license](LICENSE).
