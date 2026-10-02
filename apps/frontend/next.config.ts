import { withSentryConfig } from "@sentry/nextjs";
import path from "path";
import { legacyRedirects } from "./redirects";
import { getNextImageRemotePatterns } from "./src/utils/imageSecurity";
import { getSecurityHeaders } from "./src/utils/securityHeaders";

/**
 * Load build version from generated JSON file
 * This version is used for cache invalidation and is injected as NEXT_PUBLIC_BUILD_VERSION!
 */
let BUILD_VERSION = "dev";

try {
  const fs = require("fs");
  const buildVersionPath = path.join(__dirname, "src/constants/build-version.json");

  if (fs.existsSync(buildVersionPath)) {
    const buildVersionData = JSON.parse(fs.readFileSync(buildVersionPath, "utf-8"));
    BUILD_VERSION = buildVersionData.BUILD_VERSION || BUILD_VERSION;
  }
} catch (error) {
  // Fallback to 'dev' if file doesn't exist or can't be read
  if (process.env.NODE_ENV === "production") {
    console.warn("[Next Config] Warning: Could not load build version, using fallback");
  }
}

// Inject build version as environment variable for client-side access
process.env.NEXT_PUBLIC_BUILD_VERSION = BUILD_VERSION;

const DEPLOYMENT_ID = process.env.NEXT_DEPLOYMENT_ID?.trim() || "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  // Native IDs omit some server chunks in the installed Turbopack build.
  // Let the existing Sentry post-build hook inject matching IDs into all artifacts.
  turbopack: { debugIds: false },
  cacheHandlers: {
    remote: require.resolve("./cache-handlers/redis-remote.cjs"),
  },
  cacheLife: {
    storefrontPublic: {
      stale: 300,
      revalidate: 300,
      expire: 3600,
    },
    // Commerce pages whose payload carries stock and price. The window is
    // deliberately tiny: it exists to collapse duplicate renders of the same URL
    // under load, not to hold data. At 4k concurrent this still turns thousands
    // of identical renders into one per URL per 5s, while being *fresher* than
    // the 30s (PDP) / 120s (PLP) fetch windows it replaces.
    storefrontLive: {
      // 30s, not 5s. Under load every distinct hot URL is re-rendered once per
      // TTL regardless of traffic volume, so the render cost is
      // (hot URLs / TTL) x render cost. Measured on prod: 359 hot URLs at a 5s
      // TTL cost ~12 of 64 cores in steady state even at a 100% cache hit rate.
      // At 30s that is ~2 cores, and it is what makes a wide catalog affordable.
      stale: 30,
      revalidate: 30,
      // Must exceed `revalidate`; it is the hard ceiling before Next falls back
      // to a fully dynamic render, not an expected staleness.
      expire: 300,
    },
  },
  // Rolling deploys put old and new builds behind one gateway for minutes, and
  // an edge in front can hold a page from build A while B is live. With this
  // set, assets carry `?dpl=`, navigations carry `x-deployment-id`, and a
  // mismatch makes the client do a full reload instead of a broken client-side
  // transition. Also folds into the `use cache` key, so a release cannot serve
  // another release's cached data.
  //
  // Spread rather than assigned, because the KEY BEING PRESENT is what matters:
  // Next does `process.env.NEXT_DEPLOYMENT_ID = config.deploymentId || ""` at
  // build time (next/dist/build/index.js), and an empty id makes some asset
  // URLs carry a valueless `?dpl=` while others omit it. The same chunk then
  // appears under two URLs and the browser downloads it twice — measured at 56
  // requests / 2.2 MB against 37 / 1.7 MB on a PLP. An unset variable must
  // leave the feature off, not half on.
  ...(DEPLOYMENT_ID ? { deploymentId: DEPLOYMENT_ID } : {}),
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: [
    "@repo/api",
    "@repo/brand",
    "@repo/fonts",
    "@repo/social-posts",
    "@repo/story-rail",
    "@repo/video-player",
  ],
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    const versionProbeHeaders = [
      { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
    ];
    return [
      {
        source: "/(.*)",
        headers: getSecurityHeaders(),
      },
      {
        source: "/build-version.json",
        headers: versionProbeHeaders,
      },
      {
        source: "/sw.js",
        headers: versionProbeHeaders,
      },
      {
        source: "/sw-retire.js",
        headers: versionProbeHeaders,
      },
      {
        source: "/sw-version.js",
        headers: versionProbeHeaders,
      },
    ];
  },
  async redirects() {
    return legacyRedirects;
  },
  async rewrites() {
    const proxyTarget = process.env.E2E_API_PROXY_TARGET?.trim().replace(/\/$/, "");
    if (!proxyTarget) {
      return [];
    }

    return [
      {
        source: "/api/:path*",
        destination: `${proxyTarget}/api/:path*`,
      },
      {
        source: "/uploads/:path*",
        destination: `${proxyTarget}/uploads/:path*`,
      },
    ];
  },
  // Allow sitemap and other static generation to run longer during build (default 60s)
  staticPageGenerationTimeout: 180,
  compiler: {
    async runAfterProductionCompile({ distDir }: { distDir: string }) {
      const { prepareServerMapReferences } = require("./scripts/prepare-sentry-server-maps.cjs");
      prepareServerMapReferences(path.join(distDir, "server"));
    },
    removeConsole: process.env.NODE_ENV === "production",
    // Remove SDK-internal debug branches with Turbopack too. Structured Logs,
    // Issues, tracing and Replay do not depend on this debug-only build flag.
    ...(process.env.NODE_ENV === "production" ? { define: { __SENTRY_DEBUG__: false } } : {}),
  },
  images: {
    unoptimized: false,
    // Resizing moves to the edge. The loader emits
    // `https://cdn.infinitycolor.co/uploads/<file>?width=<w>` for catalogue
    // media, so the origin serves originals off disk instead of running sharp
    // and keeping 8,434 derivatives — and the edge caches each size once per
    // PoP rather than the origin serving every byte.
    //
    // Setting this REMOVES `/_next/image`: the Next server calls `render404()`
    // for that route whenever `images.loader !== "default"`
    // (`next/dist/server/next-server.js`, in `handleNextImageRequest`). There is
    // no optimizer fallback, so `edgeImageUrl` must return a directly-servable
    // URL for every input — local `public/` assets included. `deviceSizes`,
    // `imageSizes`, `qualities`, `formats`, `minimumCacheTTL` and
    // `remotePatterns` below are inert while a custom loader is configured; they
    // are kept so that dropping `loader`/`loaderFile` restores the optimizer in
    // one edit.
    loader: "custom",
    loaderFile: "./src/utils/arvanImageLoader.ts",
    // Allow local backend image URLs (localhost/127.0.0.1) during local development.
    dangerouslyAllowLocalIP: process.env.NODE_ENV !== "production",
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    qualities: [50, 60, 70, 75, 90, 95, 100],
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 60 * 60 * 24 * 30,
    dangerouslyAllowSVG: false,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: getNextImageRemotePatterns(),
  },
  experimental: {
    serverSourceMaps: true,
    useOffline: true,
    turbopackRustReactCompiler: process.env.NODE_ENV !== "test",
    exposeTestingApiInProductionBuild: process.env.NEXT_INSTANT_TESTS === "true",
    optimizePackageImports: ["@heroicons/react", "lucide-react", "react-icons", "framer-motion"],
    scrollRestoration: true,
    optimizeCss: true,
  },
  serverExternalPackages: ["jsdom"],
  // Disabled: Nginx already compresses responses; double compression wastes CPU on all instances.
  compress: false,
  // Custom cache handler: Redis + LRU fallback (cache-handler.mjs). Shared cache across instances for production load.
  cacheHandler:
    process.env.NODE_ENV === "production" ? require.resolve("./cache-handler.mjs") : undefined,
  // Force all replicas through the shared handler. A per-process L1 cache makes
  // invalidation inconsistent and can leave the Redis handler unused.
  cacheMaxMemorySize: 0,
};
module.exports = withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  org: process.env.SENTRY_ORG || "alpagency",
  project: process.env.SENTRY_PROJECT || "infinitycolor-frontend",
  sentryUrl: process.env.SENTRY_URL || "https://errors.alpagency.net",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    // Server maps use the mandatory bounded upload inside the build-secret
    // step. Keep the SDK's browser upload and public map deletion intact.
    assets: [path.resolve(__dirname, ".next/static")],
    deleteSourcemapsAfterUpload: true,
  },
  widenClientFileUpload: true,
  release: { name: process.env.SENTRY_RELEASE || process.env.GITHUB_SHA },
});
