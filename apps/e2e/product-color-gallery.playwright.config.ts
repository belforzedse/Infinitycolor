import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/storefront",
  testMatch: "product-color-gallery.spec.ts",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  outputDir: "test-results/product-color-gallery",
  reporter: "list",
  use: {
    baseURL: "http://localhost:4310",
    trace: "retain-on-failure",
    channel: process.env.GALLERY_E2E_BROWSER_CHANNEL,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer:
    process.env.GALLERY_E2E_EXTERNAL === "true"
      ? undefined
      : {
          command: "node scripts/product-color-gallery-server.mjs",
          url: "http://localhost:4310/pdp/gallery-colors",
          timeout: 600_000,
          reuseExistingServer: false,
        },
});
