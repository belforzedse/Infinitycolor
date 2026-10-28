import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/runtime",
  testMatch: "service-worker-retirement.spec.ts",
  workers: 1,
  timeout: 30_000,
  use: { serviceWorkers: "allow" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
