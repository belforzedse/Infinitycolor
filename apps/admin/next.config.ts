import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import { getNextImageRemotePatterns } from "./src/utils/imageSecurity";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@repo/api", "@repo/auth-core", "@repo/brand", "@repo/fonts", "@repo/ui"],
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
  async rewrites() {
    const target = process.env.E2E_API_PROXY_TARGET?.trim().replace(/\/$/, "");
    if (!target) return [];
    return [
      { source: "/api/backend/:path*", destination: `${target}/api/:path*` },
      { source: "/uploads/:path*", destination: `${target}/uploads/:path*` },
    ];
  },
  images: {
    dangerouslyAllowLocalIP:
      process.env.NODE_ENV !== "production" ||
      process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT === "e2e",
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
    optimizePackageImports: ["lucide-react", "react-icons"],
    scrollRestoration: true,
  },
  serverExternalPackages: ["jsdom"],
  compress: false,
};

export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  sourcemaps: { disable: false, deleteSourcemapsAfterUpload: true },
  widenClientFileUpload: true,
  release: { name: process.env.SENTRY_RELEASE || process.env.RELEASE_SHA || "development" },
});
