import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  cacheHandlers: {
    remote: require.resolve("./cache-handlers/redis-remote.cjs"),
  },
  cacheLife: {
    socialPublic: {
      stale: 300,
      revalidate: 300,
      expire: 3600,
    },
  },
  experimental: {
    useOffline: true,
    exposeTestingApiInProductionBuild:
      process.env.NEXT_INSTANT_TESTS === "true",
  },
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: [
    "@repo/api",
    "@repo/auth-core",
    "@repo/auth-ui",
    "@repo/brand",
    "@repo/fonts",
    "@repo/social-posts",
    "@repo/story-rail",
  ],
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Service-Worker-Allowed",
            value: "/",
          },
        ],
      },
    ];
  },
  images: {
    // Strapi uploads (any API host) + demo images
    remotePatterns: [
      { protocol: "https", hostname: "**", pathname: "/**" },
      { protocol: "http", hostname: "**", pathname: "/**" },
    ],
    dangerouslyAllowLocalIP: process.env.NODE_ENV !== "production",
  },
};

export default nextConfig;
