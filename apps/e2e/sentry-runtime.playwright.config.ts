import { defineConfig, devices } from "@playwright/test";

// Run against a separately built production storefront with an isolated API fixture.
export default defineConfig({
  testDir: "./tests/runtime",
  testMatch: "storefront-sentry.spec.ts",
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: process.env.E2E_STOREFRONT_URL || "http://127.0.0.1:4330",
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
