ARG BASE_IMAGE=infinity-importer-opt:20260805-v14-order-toman
FROM ${BASE_IMAGE}

COPY apps/backend/scripts/woocommerce-sync /app/scripts/woocommerce-sync
COPY apps/backend/database/migrations/2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js \
  /app/database/migrations/2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/transforms.js \
  /app/scripts/woocommerce-importer/catalog/lib/transforms.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/transforms.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/transforms.test.js
