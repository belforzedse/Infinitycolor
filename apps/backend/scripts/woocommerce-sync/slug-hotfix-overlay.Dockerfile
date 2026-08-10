ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Intentionally narrow: production may run a newer sync-service image than the
# repository's general overlay base. Replace only the canonical slug resolver
# and its regression test so unrelated service behavior cannot be downgraded.
COPY apps/backend/scripts/woocommerce-importer/catalog/lib/slug.js \
  /app/scripts/woocommerce-importer/catalog/lib/slug.js
COPY apps/backend/scripts/woocommerce-importer/catalog/__tests__/slug.test.js \
  /app/scripts/woocommerce-importer/catalog/__tests__/slug.test.js

RUN node --test /app/scripts/woocommerce-importer/catalog/__tests__/slug.test.js
