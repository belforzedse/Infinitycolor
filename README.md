# InfinityColor

InfinityColor is the Persian storefront and commerce platform that replaced a WooCommerce shop. The move carried over **65,521 orders** and **about 88,000 customer accounts** with their order history.

![InfinityColor brand artwork](docs/branding/cover.jpg)

The project history starts on July 25, 2025 and follows the development of the storefront, staff tools, and WooCommerce migration.

## Inside the repository

| Area | Source |
| --- | --- |
| Next.js storefront, catalog, and cart | [apps/frontend](apps/frontend) |
| Strapi commerce API with PostgreSQL and Redis | [apps/backend](apps/backend) |
| Staff admin and account sessions | [apps/admin](apps/admin), [apps/auth](apps/auth) |
| WooCommerce import, dry runs, and reconciliation | [Migration runner](apps/backend/scripts/woocommerce-importer/migration-v2) |
| Shared contracts and UI | [packages](packages) |

The importer reads from WooCommerce, checks dependencies before writing to Strapi, and supports resuming and reconciling an import.

## Run locally

Use Node.js 20.19+ within the 20.x line, pnpm 10.28.2, and Docker Compose. The [development guide](docs/development.md) covers environment setup, starting the storefront and API, and running checks. Use your own local catalog to browse products.

[MIT license](LICENSE).
