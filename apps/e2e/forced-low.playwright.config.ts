import { defineConfig } from "@playwright/test";
import parityConfig from "./static-parity.playwright.config";
import { extendWebServers } from "./helpers/web-servers";

export default defineConfig({
  ...parityConfig,
  testMatch: ["**/forced-low-static-parity.spec.ts"],
  outputDir: "test-results/forced-low",
  reporter: [
    [process.env.CI ? "dot" : "list"],
    ["junit", { outputFile: "forced-low-e2e-results.xml" }],
    [
      "html",
      {
        outputFolder: "playwright-report/forced-low",
        open: "never",
      },
    ],
  ],
  webServer: extendWebServers(parityConfig.webServer, {
    timeout: Number(process.env.E2E_WEB_SERVER_TIMEOUT_MS || 300_000),
    env: {
      NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE: "true",
      NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_E2E: "true",
    },
  }),
});
