ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Intentionally narrow, matching the woocommerce-sync overlays: production may run a newer
# backend image than this checkout, so a wholesale copy could silently downgrade unrelated
# service behaviour. Only the normalization code and its entrypoint are added.
COPY apps/backend/src/services/media /app/src/services/media
COPY apps/backend/scripts/media /app/scripts/media

USER root

# ffmpeg lives in Alpine's community repository, which the runner already uses for vips.
# fallback-apk.sh is required: the default Alpine CDN is unreachable from this network.
RUN /usr/local/bin/fallback-apk.sh ffmpeg \
  && ffprobe -version >/dev/null \
  && ffmpeg -version >/dev/null

# The runtime image ships compiled JS, not sources. Compile just these files, keeping the
# repository layout so `dist/scripts/media/...` resolves `../../src/...` to the existing
# `dist/src/...` — including `src/queue/strapi-instance`, which the base image already has.
RUN cd /app \
  && node_modules/.bin/tsc \
       src/services/media/video-normalization.ts \
       src/services/media/normalize-upload-video.ts \
       src/services/media/normalize-story-video.ts \
       src/services/media/normalize-product-video.ts \
       scripts/media/normalize-story-videos.ts \
       scripts/media/normalize-product-videos.ts \
       --outDir dist --rootDir . --module commonjs --moduleResolution node \
       --target es2022 --esModuleInterop --skipLibCheck \
  && node dist/scripts/media/normalize-story-videos.js --help >/dev/null 2>&1 || true \
  && node dist/scripts/media/normalize-product-videos.js --help >/dev/null 2>&1 || true \
  && test -f dist/scripts/media/normalize-story-videos.js \
  && test -f dist/scripts/media/normalize-product-videos.js \
  && test -f dist/src/services/media/normalize-upload-video.js \
  && test -f dist/src/services/media/normalize-story-video.js \
  && test -f dist/src/services/media/normalize-product-video.js
