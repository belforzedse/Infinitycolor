ARG BASE_IMAGE=infinity-importer-opt:20260805-v14-order-toman
FROM ${BASE_IMAGE}

COPY apps/backend/scripts/woocommerce-sync /app/scripts/woocommerce-sync
COPY apps/backend/scripts/woocommerce-importer/migration-v2 \
  /app/scripts/woocommerce-importer/migration-v2
COPY apps/backend/database/migrations/2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js \
  /app/database/migrations/2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js
COPY apps/backend/database/migrations/2026.08.07T18.00.00.add-customer-identity-lifecycle.js \
  /app/database/migrations/2026.08.07T18.00.00.add-customer-identity-lifecycle.js
COPY apps/backend/database/migrations/2026.08.08T12.00.00.add-product-scheduled-publication.js \
  /app/database/migrations/2026.08.08T12.00.00.add-product-scheduled-publication.js

# Shared catalog media pipeline (authoritative for product images).
COPY apps/backend/scripts/woocommerce-importer/catalog/engine.js \
  /app/scripts/woocommerce-importer/catalog/engine.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/media.js \
  /app/scripts/woocommerce-importer/catalog/lib/media.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/report.js \
  /app/scripts/woocommerce-importer/catalog/lib/report.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/presets.js \
  /app/scripts/woocommerce-importer/catalog/lib/presets.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/backoff.js \
  /app/scripts/woocommerce-importer/catalog/lib/backoff.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/transforms.js \
  /app/scripts/woocommerce-importer/catalog/lib/transforms.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/slug.js \
  /app/scripts/woocommerce-importer/catalog/lib/slug.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/publication.js \
  /app/scripts/woocommerce-importer/catalog/lib/publication.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/mediaRecovery.js \
  /app/scripts/woocommerce-importer/catalog/lib/mediaRecovery.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/mediaMappingStore.js \
  /app/scripts/woocommerce-importer/catalog/lib/mediaMappingStore.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/safeUrl.js \
  /app/scripts/woocommerce-importer/catalog/lib/safeUrl.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/concurrency.js \
  /app/scripts/woocommerce-importer/catalog/lib/concurrency.js
COPY apps/backend/scripts/woocommerce-importer/catalog-media-recover.js \
  /app/scripts/woocommerce-importer/catalog-media-recover.js
COPY apps/backend/scripts/woocommerce-importer/utils/ImageUploader.js \
  /app/scripts/woocommerce-importer/utils/ImageUploader.js
COPY apps/backend/scripts/woocommerce-importer/utils/mediaUtils.js \
  /app/scripts/woocommerce-importer/utils/mediaUtils.js
COPY apps/backend/scripts/woocommerce-importer/importers/ProductImporter.js \
  /app/scripts/woocommerce-importer/importers/ProductImporter.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/transforms.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/transforms.test.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/slug.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/slug.test.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/media.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/media.test.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/publication.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/publication.test.js
