import { defineConfig, devices, type ReporterDescription } from "@playwright/test";
import { stagingTargets } from "./fixtures/staging";

/**
 * The staging suite: real shopper journeys against a deployed environment
 * (staging by default), with test data from the backend's fixture API.
 *
 *   @critical   blocks promotion to production (checkout up to payment)
 *   @purchase   completes payment; runs on every dev push but never blocks
 *   @regression broader behaviour; nightly and on demand
 *
 * CI jobs pick tags with --grep and devices with --project; see
 * .gitlab/ci/staging-release.yml and README.md.
 */
const isCI = !!process.env.CI;
const junitFile = process.env.E2E_JUNIT_FILE || "reports/e2e-staging.xml";

const reporter: ReporterDescription[] = isCI
  ? [
      ["dot"],
      ["junit", { outputFile: junitFile }],
      // Sharded jobs emit blobs that e2e:staging:report merges into one HTML report.
      process.env.E2E_BLOB_REPORT === "1"
        ? ["blob", { outputDir: "blob-report" }]
        : ["html", { outputFolder: "playwright-report/staging", open: "never" }],
    ]
  : [["list"], ["html", { outputFolder: "playwright-report/staging", open: "never" }]];

export default defineConfig({
  testDir: "./tests/staging",
  outputDir: "test-results/staging",
  globalSetup: "./scripts/staging-global-setup.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  // One retry absorbs a dropped connection to a remote environment; the
  // report still marks the test flaky.
  retries: isCI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS || 2),
  // A journey crosses three origins over the network.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter,
  use: {
    baseURL: stagingTargets().storefront,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    // The storefront's service worker has its own tests; here it would only
    // add controller-change reloads to a checkout.
    serviceWorkers: "block",
    // The trace of the first failure is the one worth having; passing tests
    // keep nothing.
    trace: "retain-on-first-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1100 } },
    },
    // Most shoppers are on phones, many inside Instagram's in-app browser
    // (Chromium on Android, WebKit on iOS).
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 14"] } },
  ],
});
