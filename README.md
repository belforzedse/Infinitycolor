<p align="center">
  <img src="docs/branding/logo.png" alt="Infinitycolor" width="220">
</p>

# Infinitycolor

Infinitycolor is a commerce platform for the Iranian market. The Persian storefront uses Next.js and React; Strapi owns the commerce API,
catalog, orders, and payment integrations.

![Infinitycolor brand artwork](docs/branding/cover.jpg)

## Workspaces

- `apps/frontend` — customer storefront
- `apps/admin` — custom administration
- `apps/auth` — central session runtime
- `apps/social` — social content application
- `apps/backend` — Strapi commerce API and jobs
- `apps/e2e` — Playwright coverage
- `packages/*` — shared authentication, UI, types, and utilities

## Local setup

Use Node.js 20, pnpm 10.28.2 through Corepack, PostgreSQL 16, and Redis 7.
Dependency versions and commands are recorded in the root and app manifests.

```bash
corepack enable
pnpm install --frozen-lockfile
```

Configure this project's environment files before starting the apps. The
[backend guide](apps/backend/README.md) and [storefront guide](apps/frontend/README.md)
describe their configuration.

```bash
pnpm --filter @repo/backend dev
pnpm --filter @repo/frontend dev
```

The backend listens on `http://localhost:1337`; the storefront uses
`http://localhost:2888`. Each app has its own environment and service origins.

Authentication ownership and local service setup are documented in the
[architecture](docs/auth/architecture.md) and [operations guide](docs/auth/operations.md).

## Checks

```bash
pnpm lint
pnpm check-types
pnpm test
pnpm build
```

## Documentation and releases

- [GitLab CI](.gitlab-ci.yml)
- [Production release guide](deploy/production/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Issues](https://git.alpagency.net/bel4/infinity/-/issues)
- [Merge requests](https://git.alpagency.net/bel4/infinity/-/merge_requests)

## License

[MIT](LICENSE).

## Team setup

- [Linux and Windows development guide](docs/development.md)
- [GitLab workflow and collaboration templates](docs/gitlab-workflow.md)
