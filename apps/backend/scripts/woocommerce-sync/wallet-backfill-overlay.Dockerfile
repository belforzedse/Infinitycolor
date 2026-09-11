ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Intentionally narrow, for the same reason as slug-hotfix-overlay: production
# may run a newer sync image than this checkout, so a wholesale copy of
# migration-v2/ could silently downgrade unrelated service behavior.
#
# transforms.js — customerPayload() falls back to the Woo login username when
# billing/shipping phone is empty. Without it the legacy TeraWallet holders are
# dropped as USER_PHONE_INVALID and their wallets never land.
# backfill-wallets.js — the targeted recovery runner.
COPY apps/backend/scripts/woocommerce-importer/migration-v2/lib/transforms.js \
  /app/scripts/woocommerce-importer/migration-v2/lib/transforms.js
COPY apps/backend/scripts/woocommerce-importer/migration-v2/__tests__/transforms.test.js \
  /app/scripts/woocommerce-importer/migration-v2/__tests__/transforms.test.js
COPY apps/backend/scripts/woocommerce-importer/migration-v2/backfill-wallets.js \
  /app/scripts/woocommerce-importer/migration-v2/backfill-wallets.js

RUN node --test /app/scripts/woocommerce-importer/migration-v2/__tests__/transforms.test.js \
  && node /app/scripts/woocommerce-importer/migration-v2/backfill-wallets.js --help >/dev/null
