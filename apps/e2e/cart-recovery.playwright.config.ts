import { defineConfig, devices } from "@playwright/test";

// Production storefront and loopback catalog, with no real accounts or database.
export default defineConfig({
  testDir: "./tests/runtime",
  testMatch: "cart-recovery.spec.ts",
  workers: 1,
  timeout: 45_000,
  outputDir: "test-results/cart-recovery",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4330",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"] } },
    { name: "webkit-mobile", use: { ...devices["iPhone 13"] } },
  ],
  webServer: [
    {
      command: "node scripts/cart-recovery-fixture.mjs",
      url: "http://127.0.0.1:4341/api/_health",
      reuseExistingServer: true,
    },
    {
      command:
        "pnpm --filter @repo/frontend exec next build && pnpm --filter @repo/frontend exec next start --hostname 127.0.0.1 --port 4330",
      url: "http://127.0.0.1:4330/categories",
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        NEXT_PUBLIC_AUTH_ENVIRONMENT: "e2e",
        NEXT_PUBLIC_AUTH_ORIGIN: "http://localhost:2889",
        NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:4341/api",
        NEXT_PUBLIC_IMAGE_BASE_URL: "http://127.0.0.1:4341",
        STRAPI_INTERNAL_URL: "http://127.0.0.1:4341/api",
        STRAPI_BUILD_TIME_URL: "http://127.0.0.1:4341/api",
        NEXT_PUBLIC_STRAPI_TOKEN: "",
        FRONTEND_REDIS_URL: "",
        NEXT_PUBLIC_SENTRY_DSN: "",
        SENTRY_DSN: "",
        NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED: "true",
        NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE: "true",
        NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT: "100",
        NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE: "false",
        NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_E2E: "true",
      },
    },
  ],
});
