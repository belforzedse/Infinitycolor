ARG BASE_IMAGE=infinity-importer-opt:20260805-v14-order-toman
FROM ${BASE_IMAGE}

COPY apps/backend/scripts/woocommerce-sync /app/scripts/woocommerce-sync
COPY apps/backend/scripts/woocommerce-importer/migration-v2 \
  /app/scripts/woocommerce-importer/migration-v2
COPY apps/backend/database/migrations/2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js \
  /app/database/migrations/2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js
COPY apps/backend/database/migrations/2026.08.07T18.00.00.add-customer-identity-lifecycle.js \
  /app/database/migrations/2026.08.07T18.00.00.add-customer-identity-lifecycle.js
COPY apps/backend/database/migrations/2026.09.10T12.00.00.widen-woocommerce-sync-campaigns-status.js \
  /app/database/migrations/2026.09.10T12.00.00.widen-woocommerce-sync-campaigns-status.js
COPY apps/backend/scripts/woocommerce-importer/catalog \
  /app/scripts/woocommerce-importer/catalog
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/transforms.js \
  /app/scripts/woocommerce-importer/catalog/lib/transforms.js
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/slug.js \
  /app/scripts/woocommerce-importer/catalog/lib/slug.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/transforms.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/transforms.test.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/slug.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/slug.test.js

# Full catalog overlay includes categoryEditorial.js, which needs sanitize-html.
# The hourly sync base uses a pnpm node_modules layout, so a flat npm install
# into /app/node_modules will not resolve. Install beside the importer tree so
# Node's walk-up from catalog/lib finds it.
USER root
RUN mkdir -p /tmp/sanitize-install \
  && cd /tmp/sanitize-install \
  && npm init -y >/dev/null \
  && npm install --omit=dev sanitize-html@2.17.0 \
  && mkdir -p /app/scripts/woocommerce-importer/node_modules \
  && cp -a node_modules/. /app/scripts/woocommerce-importer/node_modules/ \
  && rm -rf /tmp/sanitize-install \
  && node -e "require('/app/scripts/woocommerce-importer/catalog/lib/categoryEditorial'); console.log('sanitize-html-ok')"
