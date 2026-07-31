import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

const projects = [
  {
    name: "chromium-mobile-390",
    use: {
      ...devices["Pixel 7"],
      viewport: { width: 390, height: 844 },
    },
  },
  {
    name: "chromium-tablet-768",
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 768, height: 1024 },
      hasTouch: true,
      isMobile: true,
    },
  },
  {
    name: "chromium-laptop-1280",
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1280, height: 800 },
    },
  },
  {
    name: "chromium-desktop-1440",
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1440, height: 1100 },
    },
  },
] as const;

export default defineConfig({
  ...baseConfig,
  testMatch: ["**/static-parity.spec.ts"],
  fullyParallel: false,
  outputDir: "test-results/static-parity",
  reporter: [
    [process.env.CI ? "dot" : "list"],
    ["junit", { outputFile: "static-parity-e2e-results.xml" }],
    [
      "html",
      {
        outputFolder: "playwright-report/static-parity",
        open: "never",
      },
    ],
  ],
  projects,
  webServer: baseConfig.webServer
    ? {
        ...baseConfig.webServer,
        timeout: Number(process.env.E2E_WEB_SERVER_TIMEOUT_MS || 300_000),
        env: {
          ...baseConfig.webServer.env,
          NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED: "true",
          NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE: "true",
          NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION: "true",
          NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY: "false",
          NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT: "100",
          NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE: "false",
          NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_E2E: "true",
        },
      }
    : undefined,
});
