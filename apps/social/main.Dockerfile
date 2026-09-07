# syntax=docker.arvancloud.ir/docker/dockerfile:1.7
FROM docker.arvancloud.ir/library/node:22-alpine AS builder

WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
ARG NPM_REGISTRY_URL="https://mirror.abrha.net/repository/npm/"
ARG NPM_REGISTRY_SECOND_FALLBACK_URL="https://package-mirror.liara.ir/repository/npm/"
ARG NPM_REGISTRY_THIRD_FALLBACK_URL="https://mirror-npm.runflare.com/"
ARG NPM_REGISTRY_FALLBACK_URL="https://registry.npmjs.org/"

COPY .cursor/docker/fallback-registry.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/fallback-registry.sh

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/social/package.json ./apps/social/package.json
COPY packages ./packages
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/root/.cache/node/corepack \
    fallback-registry.sh "${NPM_REGISTRY_URL}" "${NPM_REGISTRY_SECOND_FALLBACK_URL}" "${NPM_REGISTRY_THIRD_FALLBACK_URL}" "${NPM_REGISTRY_FALLBACK_URL}" \
    pnpm install --filter @repo/social... --frozen-lockfile

COPY apps/social ./apps/social

ARG NEXT_PUBLIC_API_BASE_URL="https://api.infinitycolor.co/api"
ARG NEXT_PUBLIC_IMAGE_BASE_URL="https://api.infinitycolor.co"
ARG NEXT_PUBLIC_SITE_URL="https://infinitygram.co"
ARG NEXT_PUBLIC_AUTH_ENVIRONMENT="production"
ARG NEXT_PUBLIC_AUTH_ORIGIN="https://auth.infinitycolor.co"
ARG GITHUB_SHA=""

ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_IMAGE_BASE_URL=${NEXT_PUBLIC_IMAGE_BASE_URL}
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV NEXT_PUBLIC_AUTH_ENVIRONMENT=${NEXT_PUBLIC_AUTH_ENVIRONMENT}
ENV NEXT_PUBLIC_AUTH_ORIGIN=${NEXT_PUBLIC_AUTH_ORIGIN}
ENV CACHE_RELEASE_ID=${GITHUB_SHA}

WORKDIR /repo/apps/social
ENV NODE_ENV=production
RUN --mount=type=cache,id=infinity-social-next-16.3.2-node22,target=/repo/apps/social/.next/cache,sharing=locked \
    --mount=type=cache,target=/root/.cache/node/corepack \
    fallback-registry.sh "${NPM_REGISTRY_URL}" "${NPM_REGISTRY_SECOND_FALLBACK_URL}" "${NPM_REGISTRY_THIRD_FALLBACK_URL}" "${NPM_REGISTRY_FALLBACK_URL}" \
    pnpm run build

FROM docker.arvancloud.ir/library/node:22-alpine AS runner
WORKDIR /app

ARG FRONTEND_REDIS_URL=""
ARG NEXT_CACHE_ENVIRONMENT="production"
ARG NEXT_PUBLIC_AUTH_ORIGIN="https://auth.infinitycolor.co"
ARG GITHUB_SHA=""
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    AUTH_SERVER_ORIGIN=${NEXT_PUBLIC_AUTH_ORIGIN} \
    FRONTEND_REDIS_URL=${FRONTEND_REDIS_URL} \
    NEXT_CACHE_ENVIRONMENT=${NEXT_CACHE_ENVIRONMENT} \
    NEXT_CACHE_RELEASE=${GITHUB_SHA} \
    CACHE_RELEASE_ID=${GITHUB_SHA}

COPY --from=builder /repo/apps/social/.next/standalone ./
COPY --from=builder /repo/apps/social/public ./apps/social/public
COPY --from=builder /repo/apps/social/.next/static ./apps/social/.next/static

EXPOSE 3000

CMD ["node", "apps/social/server.js"]
