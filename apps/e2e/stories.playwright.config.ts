import { defineConfig, devices } from "@playwright/test";

/**
 * Stories playback suite.
 *
 * Runs against the self-contained harness in `stories-harness/` rather than the
 * storefront: the storefront fetches stories in a Server Component, which the browser
 * cannot intercept, so shaping media responses would otherwise mean seeding and booting
 * Strapi + Next. The harness mounts the same `@repo/story-rail` components the apps do.
 *
 * All three engines matter here. The defects this suite covers are browser media
 * behaviour, and Chromium, Firefox and WebKit disagree about nearly all of it — codec
 * support, range requests, autoplay and how a stalled element reports itself.
 */
const port = Number(process.env.STORIES_HARNESS_PORT || 4321);

export default defineConfig({
  testDir: "./tests/stories",
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS || 1),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    actionTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/stories-harness-server.mjs",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { STORIES_HARNESS_PORT: String(port) },
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox-desktop", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"] } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"] } },
    { name: "webkit-mobile", use: { ...devices["iPhone 14"] } },
  ],
});
