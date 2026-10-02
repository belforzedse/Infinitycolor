# syntax=docker.arvancloud.ir/docker/dockerfile:1.7
# Node 22: avoids "controller[kState].transformAlgorithm is not a function" when cache handler handles streams under load
FROM docker.arvancloud.ir/library/node:22-alpine AS builder

WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
ARG NPM_REGISTRY_URL="https://mirror.abrha.net/repository/npm/"
ARG NPM_REGISTRY_SECOND_FALLBACK_URL="https://package-mirror.liara.ir/repository/npm/"
ARG NPM_REGISTRY_THIRD_FALLBACK_URL="https://mirror-npm.runflare.com/"
ARG NPM_REGISTRY_FALLBACK_URL="https://registry.npmjs.org/"

COPY .cursor/docker/fallback-registry.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/fallback-registry.sh

# Layer caching: workspace manifests first so code-only changes don't re-run install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches ./patches
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/auth-core/package.json ./packages/auth-core/package.json
COPY packages/auth-ui/package.json ./packages/auth-ui/package.json
COPY packages/brand/package.json ./packages/brand/package.json
COPY packages/fonts/package.json ./packages/fonts/package.json
COPY packages/social-posts/package.json ./packages/social-posts/package.json
COPY packages/story-rail/package.json ./packages/story-rail/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/video-player/package.json ./packages/video-player/package.json
COPY tools/eslint/package.json ./tools/eslint/package.json
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,id=infinity-pnpm-node22,target=/pnpm-store,sharing=shared \
    --mount=type=cache,target=/root/.cache/node/corepack \
    fallback-registry.sh "${NPM_REGISTRY_URL}" "${NPM_REGISTRY_SECOND_FALLBACK_URL}" "${NPM_REGISTRY_THIRD_FALLBACK_URL}" "${NPM_REGISTRY_FALLBACK_URL}" \
    pnpm install --filter @repo/frontend... --frozen-lockfile --store-dir /pnpm-store
COPY packages ./packages
COPY tools/eslint ./tools/eslint
# Registry fallback is only for package retrieval. Compilation failures must
# remain single, original application failures.
RUN --mount=type=cache,target=/root/.cache/node/corepack \
    pnpm --filter @repo/auth-core build

COPY apps/frontend ./apps/frontend

ARG NEXT_PUBLIC_API_BASE_URL=""
ARG NEXT_PUBLIC_IMAGE_BASE_URL=""
ARG NEXT_PUBLIC_MEDIA_CDN_URL=""
# Set to "next" to keep images on the Next optimizer even when a media CDN is
# configured. This is the phase-1 rollback and the pre-cutover default: until
# Arvan Image Resize is enabled AND the zone keys on the query string, a
# `?width=` URL is served as the unresized original.
ARG NEXT_PUBLIC_IMAGE_LOADER=""
ARG NEXT_PUBLIC_STRAPI_TOKEN=""
ARG NEXT_PUBLIC_SITE_URL=""
ARG NEXT_PUBLIC_AUTH_ENVIRONMENT=""
ARG NEXT_PUBLIC_AUTH_ORIGIN=""
ARG NEXT_PUBLIC_UMAMI_URL=""
ARG NEXT_PUBLIC_UMAMI_WEBSITE_ID=""
ARG NEXT_PUBLIC_UMAMI_ENABLE_DEV="false"
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG SENTRY_ORG="alpagency"
ARG SENTRY_PROJECT="infinitycolor-frontend"
ARG SENTRY_URL="https://errors.alpagency.net"
ARG NEXT_PUBLIC_SENTRY_EXPECTED_EVENTS_TO_LOGS="false"
ARG NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID=""
ARG NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=""
ARG NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE=""
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED="true"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE="true"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION="true"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY="true"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT="100"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE="false"
# Reserve ("ارسال رزروی" / 48h) checkout UI. Build-time: flipping it needs a
# rebuild. "false" hides the option and stops the storefront sending reserve
# fields; the backend endpoints and the expiry job stay untouched.
ARG NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED="true"
# UI-only kill switch. Keep false until the environment's payment acceptance
# checks have passed; backend callbacks and reconciliation remain independent.
ARG NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED="false"
ARG STRAPI_BUILD_TIME_URL=""
ARG STRAPI_INTERNAL_URL=""
ARG FRONTEND_REDIS_URL=""
ARG CENTRAL_AUTH_CUTOVER_ENABLED="true"
ARG GITHUB_SHA=""

ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_IMAGE_BASE_URL=${NEXT_PUBLIC_IMAGE_BASE_URL}
ENV NEXT_PUBLIC_MEDIA_CDN_URL=${NEXT_PUBLIC_MEDIA_CDN_URL}
ENV NEXT_PUBLIC_IMAGE_LOADER=${NEXT_PUBLIC_IMAGE_LOADER}
ENV NEXT_PUBLIC_STRAPI_TOKEN=${NEXT_PUBLIC_STRAPI_TOKEN}
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV NEXT_PUBLIC_AUTH_ENVIRONMENT=${NEXT_PUBLIC_AUTH_ENVIRONMENT}
ENV NEXT_PUBLIC_AUTH_ORIGIN=${NEXT_PUBLIC_AUTH_ORIGIN}
ENV NEXT_PUBLIC_UMAMI_URL=${NEXT_PUBLIC_UMAMI_URL}
ENV NEXT_PUBLIC_UMAMI_WEBSITE_ID=${NEXT_PUBLIC_UMAMI_WEBSITE_ID}
ENV NEXT_PUBLIC_UMAMI_ENABLE_DEV=${NEXT_PUBLIC_UMAMI_ENABLE_DEV}
ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}
ENV SENTRY_ORG=${SENTRY_ORG}
ENV SENTRY_PROJECT=${SENTRY_PROJECT}
ENV SENTRY_URL=${SENTRY_URL}
ENV NEXT_PUBLIC_SENTRY_EXPECTED_EVENTS_TO_LOGS=${NEXT_PUBLIC_SENTRY_EXPECTED_EVENTS_TO_LOGS}
ENV NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID=${NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID}
ENV NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=${NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE}
ENV NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE=${NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE}
ENV NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED=${NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED}
ENV NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED=${NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED}
ENV STRAPI_BUILD_TIME_URL=${STRAPI_BUILD_TIME_URL}
ENV STRAPI_INTERNAL_URL=${STRAPI_INTERNAL_URL}
ENV FRONTEND_REDIS_URL=${FRONTEND_REDIS_URL}
ENV CENTRAL_AUTH_CUTOVER_ENABLED=${CENTRAL_AUTH_CUTOVER_ENABLED}
ENV GITHUB_SHA=${GITHUB_SHA}
ENV NEXT_PUBLIC_RELEASE_SHA=${GITHUB_SHA}
# Version-skew protection, derived from the release rather than from a new build
# argument so both deploy paths (CI and ~bel4/build-all.sh) get it for free --
# they already agree on GITHUB_SHA. Assets carry `?dpl=`, navigations carry
# `x-deployment-id`, and a client holding a page from the previous build does a
# full reload instead of a half-broken client-side transition.
ENV NEXT_DEPLOYMENT_ID=${GITHUB_SHA}

WORKDIR /repo/apps/frontend
ENV NODE_ENV=production
# Secret values do not invalidate BuildKit's cache; their availability must.
ARG SENTRY_UPLOAD_ENABLED="false"
RUN --mount=type=cache,id=infinity-frontend-next-16.3.2-node22,target=/repo/apps/frontend/.next/cache,sharing=locked \
    --mount=type=cache,target=/root/.cache/node/corepack \
    --mount=type=secret,id=sentry_auth_token \
    if [ "$SENTRY_UPLOAD_ENABLED" = "true" ]; then test -s /run/secrets/sentry_auth_token || exit 1; fi; \
    export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)"; \
    pnpm run build && \
    node scripts/check-sentry-server-maps.mjs && \
    node --test scripts/upload-sentry-server-maps.node-check.cjs && \
    node scripts/upload-sentry-server-maps.cjs
RUN grep -q '"/api/_health/route"' .next/server/app-paths-manifest.json
RUN node scripts/check-sentry-server-hook.mjs
RUN node scripts/check-sentry-server-maps.mjs
RUN node scripts/check-sentry-probe-exclusion.mjs

FROM docker.arvancloud.ir/library/node:22-alpine AS runner
WORKDIR /app

# Runtime env: STRAPI_INTERNAL_URL, FRONTEND_REDIS_URL (STRAPI_BUILD_TIME_URL is build-only).
ARG STRAPI_INTERNAL_URL=""
ARG FRONTEND_REDIS_URL=""
ARG NEXT_PUBLIC_AUTH_ENVIRONMENT=""
ARG GITHUB_SHA=""

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    CENTRAL_AUTH_CUTOVER_ENABLED=true \
    STRAPI_INTERNAL_URL=${STRAPI_INTERNAL_URL} \
    FRONTEND_REDIS_URL=${FRONTEND_REDIS_URL} \
    NEXT_CACHE_ENVIRONMENT=${NEXT_PUBLIC_AUTH_ENVIRONMENT} \
    NEXT_CACHE_RELEASE=${GITHUB_SHA} \
    CACHE_RELEASE_ID=${GITHUB_SHA} \
    NEXT_DEPLOYMENT_ID=${GITHUB_SHA}

COPY --from=builder /repo/apps/frontend/.next/standalone ./
COPY --from=builder /repo/apps/frontend/public ./apps/frontend/public
COPY --from=builder /repo/apps/frontend/.next/static ./apps/frontend/.next/static

EXPOSE 3000

CMD ["node", "apps/frontend/server.js"]
