# syntax=docker.arvancloud.ir/docker/dockerfile:1.7
FROM docker.arvancloud.ir/library/node:20-alpine AS dependencies

ARG STRAPI_DISABLE_SOURCEMAPS=true
ARG STRAPI_TELEMETRY_DISABLED=true
ARG NODE_OPTIONS="--max-old-space-size=4096"
ARG NPM_REGISTRY_URL="https://mirror.abrha.net/repository/npm/"
ARG NPM_REGISTRY_SECOND_FALLBACK_URL="https://package-mirror.liara.ir/repository/npm/"
ARG NPM_REGISTRY_THIRD_FALLBACK_URL="https://mirror-npm.runflare.com/"
ARG NPM_REGISTRY_FALLBACK_URL="https://registry.npmjs.org/"
ENV STRAPI_DISABLE_SOURCEMAPS=${STRAPI_DISABLE_SOURCEMAPS}
ENV STRAPI_TELEMETRY_DISABLED=${STRAPI_TELEMETRY_DISABLED}
ENV NODE_OPTIONS=${NODE_OPTIONS}
ENV NODE_ENV=production
# Build must not use Redis rest-cache (no broker in builder); production runtime sets redis via deploy env.
ENV REST_CACHE_PROVIDER=memory
ENV CI=true

WORKDIR /repo

COPY .cursor/docker/fallback-apk.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/fallback-apk.sh

# Arvan APK mirror + build deps required to compile sharp against Alpine's libvips
# (avoids GitHub binary download which fails in CI due to network restrictions)
RUN /usr/local/bin/fallback-apk.sh build-base python3 vips-dev fftw-dev

# Registry fallback changes must not invalidate the expensive native toolchain.
COPY .cursor/docker/fallback-registry.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/fallback-registry.sh

# node-gyp would otherwise download headers from unofficial-builds.nodejs.org (DNS failures in CI).
# Official node:alpine already installs headers under /usr/local/include/node.
ENV npm_config_nodedir=/usr/local

# Layer caching: workspace manifests first so code-only changes don't re-run install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches ./patches
COPY apps/backend/package.json ./apps/backend/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/auth-core/package.json ./packages/auth-core/package.json
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,id=infinity-pnpm-node20,target=/pnpm-store,sharing=shared \
    --mount=type=cache,target=/root/.cache/node/corepack \
    /usr/local/bin/fallback-registry.sh "${NPM_REGISTRY_URL}" "${NPM_REGISTRY_SECOND_FALLBACK_URL}" "${NPM_REGISTRY_THIRD_FALLBACK_URL}" "${NPM_REGISTRY_FALLBACK_URL}" \
    pnpm install --filter @repo/backend... --frozen-lockfile --store-dir /pnpm-store
COPY packages/api ./packages/api
COPY packages/auth-core ./packages/auth-core
# Registry fallback is only for package retrieval. Compilation failures must
# remain single, original application failures.
RUN --mount=type=cache,target=/root/.cache/node/corepack \
    pnpm --filter @repo/auth-core build

# Materialize production dependencies before application source is copied. This
# keeps the expensive pnpm deploy layer reusable for source-only changes.
# The workspace patches storefront-only packages that the backend closure never
# installs, and a deploy treats an unused patch as fatal (ERR_PNPM_UNUSED_PATCH).
# Allow it here only, so full-workspace installs still catch a stale patch.
RUN --mount=type=cache,id=infinity-pnpm-node20,target=/pnpm-store,sharing=shared \
    --mount=type=cache,target=/root/.cache/node/corepack \
    echo "starting cacheable production dependency deploy..." \
    && /usr/local/bin/fallback-registry.sh "${NPM_REGISTRY_URL}" "${NPM_REGISTRY_SECOND_FALLBACK_URL}" "${NPM_REGISTRY_THIRD_FALLBACK_URL}" "${NPM_REGISTRY_FALLBACK_URL}" \
    pnpm --store-dir /pnpm-store --config.allow-unused-patches=true --filter @repo/backend deploy --legacy --prod /app \
    && cd /app \
    && echo "rebuilding sharp for musl runtime..." \
    && npm_config_platform=linux npm_config_arch=x64 npm_config_libc=musl pnpm rebuild sharp --unsafe-perm \
    && node -e "const sharp=require('sharp'); console.log('sharp-ok', process.platform, process.arch, sharp.versions);" \
    && node -e "const authCore=require('@repo/auth-core'); if (typeof authCore.verifyBridgeSignature !== 'function') throw new Error('auth-core-runtime-invalid'); console.log('auth-core-runtime-ok');"

FROM dependencies AS builder

COPY apps/backend ./apps/backend
WORKDIR /repo/apps/backend
RUN --mount=type=cache,target=/root/.cache/node/corepack \
    echo "starting strapi build at $(date -Iseconds)..." \
    && pnpm run build \
    && echo "strapi build finished at $(date -Iseconds)"
RUN echo "removing build artifacts..." \
    && rm -rf .strapi .cache .tmp \
    && echo "strapi build step complete"
WORKDIR /repo
RUN mkdir -p /runtime \
    && echo "copying backend runtime files..." \
    && for path in /repo/apps/backend/* /repo/apps/backend/.[!.]* /repo/apps/backend/..?*; do \
      [ -e "$path" ] || continue; \
      name="${path##*/}"; \
      case "$name" in node_modules|dist|build|.strapi|.cache|.tmp) continue ;; esac; \
      cp -a "$path" /runtime/; \
    done \
    && mkdir -p /runtime/dist /runtime/build \
    && cp -a /repo/apps/backend/dist/. /runtime/dist/ \
    && if [ -d /repo/apps/backend/build ]; then cp -a /repo/apps/backend/build/. /runtime/build/; fi \
    && mkdir -p /runtime/public/uploads \
    && cp -a /repo/apps/backend/e2e-fixtures/uploads/Cyan_DM_id_WAHX_9y_Gx_0_ea75d58006.webp /runtime/public/uploads/ \
    && echo "backend runtime assembly complete"

FROM docker.arvancloud.ir/library/node:20-alpine AS runner

ARG STRAPI_DISABLE_SOURCEMAPS=true
ARG STRAPI_TELEMETRY_DISABLED=true
ARG NODE_OPTIONS=""
ARG NPM_REGISTRY_URL="https://mirror.abrha.net/repository/npm/"
ARG NPM_REGISTRY_SECOND_FALLBACK_URL="https://package-mirror.liara.ir/repository/npm/"
ARG NPM_REGISTRY_THIRD_FALLBACK_URL="https://mirror-npm.runflare.com/"
ARG NPM_REGISTRY_FALLBACK_URL="https://registry.npmjs.org/"
ENV NODE_ENV=production \
    STRAPI_TELEMETRY_DISABLED=${STRAPI_TELEMETRY_DISABLED} \
    STRAPI_DISABLE_SOURCEMAPS=${STRAPI_DISABLE_SOURCEMAPS} \
    NODE_OPTIONS=${NODE_OPTIONS}

COPY .cursor/docker/fallback-apk.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/fallback-apk.sh
# su-exec so entrypoint can create uploads dir then run as node
# Alpine default CDN (dl-cdn.alpinelinux.org) is often unreachable from same networks as Docker Hub; use Arvan APK mirror
# ffmpeg normalizes story video uploads (see src/services/media): the catalogue arrives
# as HEVC in QuickTime containers, which Chromium parses and then decodes to nothing.
RUN /usr/local/bin/fallback-apk.sh su-exec vips vips-dev ffmpeg
COPY .cursor/docker/fallback-registry.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/fallback-registry.sh
# Prepare pnpm in the runner layer (builder corepack cache uses --mount=cache and is not COPY-able).
RUN /usr/local/bin/fallback-registry.sh "${NPM_REGISTRY_URL}" "${NPM_REGISTRY_SECOND_FALLBACK_URL}" "${NPM_REGISTRY_THIRD_FALLBACK_URL}" "${NPM_REGISTRY_FALLBACK_URL}" pnpm --version \
    && mkdir -p /home/node/.cache/node \
    && cp -a /root/.cache/node/corepack /home/node/.cache/node/ \
    && chown -R node:node /home/node/.cache

WORKDIR /app

# Keep the multi-gigabyte dependency tree independent from source-only changes.
COPY --link --from=dependencies --chown=1000:1000 /app /app
COPY --link --from=builder --chown=1000:1000 /runtime /app
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 1337
USER root
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["pnpm", "run", "start:prod"]
