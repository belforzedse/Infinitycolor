ARG BASE_IMAGE=infinity-importer-opt:20260805-v14-order-toman
FROM ${BASE_IMAGE}

COPY apps/backend/scripts/woocommerce-sync /app/scripts/woocommerce-sync
COPY apps/backend/scripts/woocommerce-importer/migration-v2 \
  /app/scripts/woocommerce-importer/migration-v2
COPY apps/backend/database/migrations/2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js \
  /app/database/migrations/2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js
COPY apps/backend/database/migrations/2026.08.07T18.00.00.add-customer-identity-lifecycle.js \
  /app/database/migrations/2026.08.07T18.00.00.add-customer-identity-lifecycle.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/transforms.js \
  /app/scripts/woocommerce-importer/catalog/lib/transforms.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/slug.js \
  /app/scripts/woocommerce-importer/catalog/lib/slug.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/transforms.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/transforms.test.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/slug.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/slug.test.js
