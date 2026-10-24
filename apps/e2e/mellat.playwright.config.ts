import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const frontendNode = process.env.MELLAT_FRONTEND_NODE || process.execPath;
const next = `"${frontendNode}" node_modules/next/dist/bin/next`;
const localNetwork = `--require=${fileURLToPath(new URL("./scripts/mellat-local-network.cjs", import.meta.url))}`;

export default defineConfig({
  testDir: "./tests/runtime",
  testMatch: "mellat-checkout.spec.ts",
  workers: 1,
  timeout: 90_000,
  outputDir: "test-results/mellat",
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:4350", serviceWorkers: "block", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node scripts/mellat-run-lab.mjs",
      url: "http://127.0.0.1:4352/__lab/health",
      reuseExistingServer: false,
      timeout: 180_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
      env: { NODE_OPTIONS: localNetwork },
    },
    {
      command: `cd ../frontend && ${process.env.MELLAT_REUSE_FRONTEND_BUILD === "1" ? "" : `${next} build && `}${next} start --hostname 127.0.0.1 --port 4350`,
      url: "http://127.0.0.1:4350/categories",
      reuseExistingServer: false,
      timeout: 300_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      env: {
        NODE_OPTIONS: localNetwork,
        NEXT_PUBLIC_AUTH_ENVIRONMENT: "e2e",
        NEXT_PUBLIC_AUTH_ORIGIN: "http://localhost:2889",
        NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:4351/api",
        NEXT_PUBLIC_IMAGE_BASE_URL: "http://127.0.0.1:4351",
        STRAPI_INTERNAL_URL: "http://127.0.0.1:4351/api",
        STRAPI_BUILD_TIME_URL: "http://127.0.0.1:4351/api",
        NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED: "false",
        NEXT_PUBLIC_STRAPI_TOKEN: "", FRONTEND_REDIS_URL: "",
        NEXT_PUBLIC_SENTRY_DSN: "", SENTRY_DSN: "", SENTRY_AUTH_TOKEN: "",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
