import { defineConfig, devices } from "@playwright/test";

/**
 * Analytics wire test: the storefront talks to a local stub collector that
 * serves the deployed Umami tracker, and the spec asserts the exact payloads.
 *
 * Point E2E_BASE_URL at a storefront built with
 *   NEXT_PUBLIC_UMAMI_ENABLE_DEV=true
 *   NEXT_PUBLIC_UMAMI_URL=http://127.0.0.1:${E2E_UMAMI_PORT:-18093}
 *   NEXT_PUBLIC_UMAMI_WEBSITE_ID=<any canonical UUID>
 * or leave it unset to let this config build and start one on :2888.
 * Every browser request to a real backend is stubbed by the spec, so nothing
 * leaves the machine except server-side page rendering.
 */
const storefrontBaseURL = process.env.E2E_BASE_URL || "http://localhost:2888";
const collectorPort = Number(process.env.E2E_UMAMI_PORT || 18093);
const analyticsEnv = [
  "NEXT_PUBLIC_UMAMI_ENABLE_DEV=true",
  `NEXT_PUBLIC_UMAMI_URL=http://127.0.0.1:${collectorPort}`,
  "NEXT_PUBLIC_UMAMI_WEBSITE_ID=123e4567-e89b-42d3-a456-426614174000",
  "NEXT_PUBLIC_AUTH_ENVIRONMENT=e2e",
  "NEXT_PUBLIC_AUTH_ORIGIN=http://localhost:2889",
  "NEXT_DEPLOYMENT_ID=analytics-wire",
].join(" ");
const standaloneDir = "apps/frontend/.next/standalone/apps/frontend";

export default defineConfig({
  testDir: "./tests/analytics",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "dot" : "list",
  use: {
    ...devices["Pixel 7"],
    baseURL: storefrontBaseURL,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    navigationTimeout: 90_000,
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: [
          `${analyticsEnv} pnpm --filter @repo/frontend build`,
          `rm -rf ${standaloneDir}/.next/static ${standaloneDir}/public`,
          `mkdir -p ${standaloneDir}/.next/static ${standaloneDir}/public`,
          `cp -R apps/frontend/.next/static/. ${standaloneDir}/.next/static/`,
          `cp -R apps/frontend/public/. ${standaloneDir}/public/`,
          `${analyticsEnv} HOSTNAME=127.0.0.1 PORT=2888 node ${standaloneDir}/server.js`,
        ].join(" && "),
        cwd: "../..",
        url: storefrontBaseURL,
        timeout: 300_000,
        reuseExistingServer: true,
      },
});
