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
COPY packages ./packages
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,id=infinity-pnpm-store,target=/pnpm-store \
    --mount=type=cache,target=/root/.cache/node/corepack \
    fallback-registry.sh "${NPM_REGISTRY_URL}" "${NPM_REGISTRY_SECOND_FALLBACK_URL}" "${NPM_REGISTRY_THIRD_FALLBACK_URL}" "${NPM_REGISTRY_FALLBACK_URL}" \
    pnpm install --filter @repo/frontend... --frozen-lockfile --store-dir /pnpm-store
RUN pnpm --filter @repo/auth-core build

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
ARG NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=""
ARG NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE=""
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED="true"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE="true"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION="true"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY="true"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT="100"
ARG NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE="false"
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
ENV NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=${NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE}
ENV NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE=${NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT}
ENV NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE=${NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE}
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
RUN --mount=type=cache,id=infinity-frontend-next-16.3.2-node22,target=/repo/apps/frontend/.next/cache,sharing=locked \
    --mount=type=cache,target=/root/.cache/node/corepack \
    fallback-registry.sh "${NPM_REGISTRY_URL}" "${NPM_REGISTRY_SECOND_FALLBACK_URL}" "${NPM_REGISTRY_THIRD_FALLBACK_URL}" "${NPM_REGISTRY_FALLBACK_URL}" \
    pnpm run build
RUN grep -q '"/api/_health/route"' .next/server/app-paths-manifest.json

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
