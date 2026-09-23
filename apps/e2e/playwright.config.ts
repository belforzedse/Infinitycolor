import { defineConfig, devices } from "@playwright/test";
import {
  centralAuthOrigin,
  storefrontBaseURL,
  strapiApiURL,
  strapiOrigin,
} from "./helpers/env";

const isCI = !!process.env.CI;
const webServerCommand = process.env.E2E_WEB_SERVER_COMMAND?.trim();
const authServerCommand = process.env.E2E_AUTH_SERVER_COMMAND?.trim();

function stringProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function resolveWebServerApiEnv(): Record<string, string> {
  const storefrontOrigin = storefrontBaseURL().replace(/\/$/, "");
  const proxyTarget = process.env.E2E_API_PROXY_TARGET?.trim();
  const configuredImageBaseUrl =
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL?.trim();

  if (proxyTarget) {
    return {
      E2E_API_PROXY_TARGET: proxyTarget.replace(/\/$/, ""),
      NEXT_PUBLIC_API_BASE_URL: `${storefrontOrigin}/api`,
      NEXT_PUBLIC_IMAGE_BASE_URL:
        configuredImageBaseUrl || storefrontOrigin,
      STRAPI_INTERNAL_URL: strapiApiURL(),
      STRAPI_BUILD_TIME_URL: strapiApiURL(),
    };
  }

  return {
    NEXT_PUBLIC_API_BASE_URL: strapiApiURL(),
    NEXT_PUBLIC_IMAGE_BASE_URL:
      configuredImageBaseUrl || strapiOrigin(),
    STRAPI_INTERNAL_URL: strapiApiURL(),
    STRAPI_BUILD_TIME_URL: strapiApiURL(),
  };
}

export default defineConfig({
  testDir: "./tests",
  // Admin CRUD now belongs to the independently runnable admin application.
  // Its dedicated config owns these files and their root-relative URLs.
  // The analytics wire test needs a storefront built against its stub
  // collector; analytics.playwright.config.ts owns it.
  testIgnore: ["super-admin/**/*.spec.ts", "analytics/**/*.spec.ts"],
  outputDir: "test-results",
  globalSetup: "./scripts/global-setup.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS || 1),
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    [isCI ? "dot" : "list"],
    ["junit", { outputFile: "e2e-results.xml" }],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: storefrontBaseURL(),
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: isCI ? "off" : "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1100 },
      },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 7"],
      },
    },
  ],
  webServer: [
    ...(authServerCommand
      ? [
          {
            command: authServerCommand,
            url: `${centralAuthOrigin().replace(/\/$/, "")}/api/health/ready`,
            name: "central-auth",
            reuseExistingServer: !isCI,
            timeout: Number(
              process.env.E2E_WEB_SERVER_TIMEOUT_MS || 120_000,
            ),
            env: stringProcessEnvironment(),
          },
        ]
      : []),
    ...(webServerCommand
      ? [
          {
            command: webServerCommand,
            url: storefrontBaseURL(),
            name: "storefront",
            reuseExistingServer: !isCI,
            timeout: Number(
              process.env.E2E_WEB_SERVER_TIMEOUT_MS || 120_000,
            ),
            env: {
              ...stringProcessEnvironment(),
              HOME_BATCHED_SECTIONS_ENABLED:
                process.env.HOME_BATCHED_SECTIONS_ENABLED ?? "true",
              HOME_BATCHED_SECTION_ALLOWLIST:
                process.env.HOME_BATCHED_SECTION_ALLOWLIST ??
                "newest,discounted",
              HOME_PRODUCT_SERVER_SHELL_SECTION:
                process.env.HOME_PRODUCT_SERVER_SHELL_SECTION ?? "newest",
              E2E_DISABLE_HOMEPAGE_FETCH_CACHE:
                process.env.E2E_DISABLE_HOMEPAGE_FETCH_CACHE ?? "1",
              ...resolveWebServerApiEnv(),
            },
          },
        ]
      : []),
  ],
});
