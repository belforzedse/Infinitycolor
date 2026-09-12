ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Deliberately narrow, for the same reason as wallet-backfill-overlay: production
# may run a newer sync image than this checkout, so a wholesale copy of
# migration-v2/ or woocommerce-sync/ could silently downgrade unrelated behavior.
#
# Fixes the 2026-09-12 crash, where a ~10s DNS blip killed a 5-hour unattended
# cutover campaign 65 minutes in and left its row stuck at `running` with no
# error recorded. Two independent defects:
#
# http.js — the retry predicate tested only `error.status`, but Node's fetch
#   reports transport failures as a bare `TypeError: fetch failed` with the real
#   reason on `error.cause.code`. Every network error therefore fell through the
#   retry loop on attempt 0, in all four clients (three source readers and the
#   destination writer). Now walks the cause chain, knows the undici UND_ERR_*
#   codes, and carries ~30s of retry budget instead of ~7.5s.
# source.js — what actually killed the process. pagesParallel prefetches a window
#   of pages and then suspends at `yield`; during that window the inflight
#   promises had no handler attached, so one rejecting became an *unhandled*
#   rejection and Node terminated the process outright, bypassing the catch in
#   friday() that would have marked the campaign failed.
# service.js / run-campaign.js / run-identity-pass.js — defence in depth. The
#   long-running worker had no unhandledRejection/uncaughtException handlers at
#   all, so the same blip would have taken hourly polling, discovery and the
#   scheduler down with it. They now log the full cause chain, mark the campaign
#   row failed (a row left at `running` is NOT terminal, so startCampaign's ON
#   CONFLICT resets it and the next scheduled campaign silently re-runs
#   everything), and exit non-zero so the `unless-stopped` container self-heals.
COPY apps/backend/scripts/woocommerce-importer/migration-v2/lib/http.js \
  /app/scripts/woocommerce-importer/migration-v2/lib/http.js
COPY apps/backend/scripts/woocommerce-importer/migration-v2/lib/source.js \
  /app/scripts/woocommerce-importer/migration-v2/lib/source.js
COPY apps/backend/scripts/woocommerce-importer/migration-v2/__tests__/http.test.js \
  /app/scripts/woocommerce-importer/migration-v2/__tests__/http.test.js
COPY apps/backend/scripts/woocommerce-importer/migration-v2/__tests__/source.test.js \
  /app/scripts/woocommerce-importer/migration-v2/__tests__/source.test.js
COPY apps/backend/scripts/woocommerce-sync/service.js \
  /app/scripts/woocommerce-sync/service.js
COPY apps/backend/scripts/woocommerce-sync/run-campaign.js \
  /app/scripts/woocommerce-sync/run-campaign.js
COPY apps/backend/scripts/woocommerce-sync/run-identity-pass.js \
  /app/scripts/woocommerce-sync/run-identity-pass.js
COPY apps/backend/scripts/woocommerce-sync/__tests__/service.test.js \
  /app/scripts/woocommerce-sync/__tests__/service.test.js

# Verify in the image rather than trusting the build context. The source.test.js
# case in particular was checked to FAIL with its fix removed, so a pass here is
# evidence the fix is really present and not just that the file copied.
RUN node --test \
      /app/scripts/woocommerce-importer/migration-v2/__tests__/http.test.js \
      /app/scripts/woocommerce-importer/migration-v2/__tests__/source.test.js \
      /app/scripts/woocommerce-sync/__tests__/service.test.js \
  && node --check /app/scripts/woocommerce-sync/run-campaign.js \
  && node --check /app/scripts/woocommerce-sync/run-identity-pass.js \
  && node -e "const { WooSyncService, describeError } = require('/app/scripts/woocommerce-sync/service'); \
      if (typeof WooSyncService.prototype.finalizeActiveCampaign !== 'function') throw new Error('finalizeActiveCampaign missing'); \
      if (typeof WooSyncService.prototype.fullUsersAndWallets !== 'function') throw new Error('fullUsersAndWallets missing'); \
      const d = describeError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })); \
      if (!d.includes('UND_ERR_CONNECT_TIMEOUT')) throw new Error('cause chain not unwrapped: ' + d); \
      const { isRetryableNetworkError } = require('/app/scripts/woocommerce-importer/migration-v2/lib/http'); \
      if (!isRetryableNetworkError({ cause: { code: 'EAI_AGAIN' } })) throw new Error('EAI_AGAIN not retryable'); \
      if (isRetryableNetworkError(new TypeError('fetch failed'))) throw new Error('bare fetch failed must not retry'); \
      console.log('transport-retry-overlay-ok')"
