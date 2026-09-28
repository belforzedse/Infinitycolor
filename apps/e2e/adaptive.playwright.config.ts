import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";
import { extendWebServers } from "./helpers/web-servers";

export default defineConfig({
  ...baseConfig,
  testMatch: ["**/adaptive-quality.spec.ts"],
  // The base config ignores this spec; testMatch alone decides here.
  testIgnore: [],
  fullyParallel: false,
  outputDir: "test-results/adaptive",
  reporter: [
    [process.env.CI ? "dot" : "list"],
    ["junit", { outputFile: "adaptive-e2e-results.xml" }],
    [
      "html",
      {
        outputFolder: "playwright-report/adaptive",
        open: "never",
      },
    ],
  ],
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1100 },
        serviceWorkers: "block",
      },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 7"],
        serviceWorkers: "block",
      },
    },
    {
      name: "firefox-desktop",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1440, height: 1100 },
        serviceWorkers: "block",
      },
    },
    {
      name: "webkit-desktop",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 1100 },
        serviceWorkers: "block",
      },
    },
  ],
  webServer: extendWebServers(baseConfig.webServer, {
    timeout: Number(process.env.E2E_WEB_SERVER_TIMEOUT_MS || 300_000),
    env: {
      NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED: "true",
      NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE: "true",
      NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION: "true",
      NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY: "true",
      NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT: "100",
      NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE: "false",
      NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_E2E: "true",
    },
  }),
});
