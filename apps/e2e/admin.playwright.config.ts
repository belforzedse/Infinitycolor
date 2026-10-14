import { defineConfig, devices } from "@playwright/test";
import {
  adminBaseURL,
  centralAuthOrigin,
  storefrontBaseURL,
  strapiApiURL,
  strapiOrigin,
} from "./helpers/env";

const isCI = !!process.env.CI;
// Playwright discards a web server's stdout by default, so a server that dies
// on start-up fails the run as "Exit code: 254" with no cause (pipelines
// 1104/1105). CI keeps the output; local runs stay quiet.
const webServerOutput = isCI
  ? ({ stdout: "pipe", stderr: "pipe" } as const)
  : {};
const authServerCommand = process.env.E2E_AUTH_SERVER_COMMAND?.trim();
const adminServerCommand = process.env.E2E_ADMIN_SERVER_COMMAND?.trim();
const storefrontServerCommand = process.env.E2E_WEB_SERVER_COMMAND?.trim();

function browserApiURL(): string {
  if (!process.env.E2E_API_PROXY_TARGET?.trim()) return strapiApiURL();
  return `${adminBaseURL().replace(/\/$/, "")}/api/backend`;
}

function browserImageOrigin(): string {
  if (process.env.E2E_API_PROXY_TARGET?.trim()) {
    return adminBaseURL().replace(/\/$/, "");
  }
  return process.env.NEXT_PUBLIC_IMAGE_BASE_URL?.trim() || strapiOrigin();
}

function storefrontServerApiEnv(): Record<string, string> {
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

function stringProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export default defineConfig({
  testDir: "./tests/super-admin",
  outputDir: "test-results/admin",
  globalSetup: "./scripts/global-setup.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS || 1),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    [isCI ? "dot" : "list"],
    ["junit", { outputFile: "e2e-admin-results.xml" }],
    ["html", { outputFolder: "playwright-report/admin", open: "never" }],
  ],
  use: {
    baseURL: adminBaseURL(),
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    // The service worker has its own source-policy tests. Blocking it here
    // avoids controller-change reloads interfering with CRUD/navigation E2E.
    serviceWorkers: "block",
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
      name: "firefox-desktop",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "webkit-desktop",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 800 },
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
            ...webServerOutput,
            timeout: Number(process.env.E2E_WEB_SERVER_TIMEOUT_MS || 120_000),
            env: {
              ...stringProcessEnvironment(),
              AUTH_TRUSTED_ADMIN_ORIGINS: adminBaseURL(),
            },
          },
        ]
      : []),
    ...(storefrontServerCommand
      ? [
          {
            command: storefrontServerCommand,
            url: storefrontBaseURL(),
            name: "storefront",
            reuseExistingServer: !isCI,
            ...webServerOutput,
            timeout: Number(process.env.E2E_WEB_SERVER_TIMEOUT_MS || 120_000),
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
              ...storefrontServerApiEnv(),
            },
          },
        ]
      : []),
    ...(adminServerCommand
      ? [
          {
            command: adminServerCommand,
            url: `${adminBaseURL().replace(/\/$/, "")}/api/health/live`,
            name: "admin",
            reuseExistingServer: !isCI,
            ...webServerOutput,
            timeout: Number(process.env.E2E_ADMIN_SERVER_TIMEOUT_MS || process.env.E2E_WEB_SERVER_TIMEOUT_MS || 120_000),
            env: {
              ...stringProcessEnvironment(),
              NEXT_PUBLIC_ADMIN_ENVIRONMENT: "e2e",
              ADMIN_URL: adminBaseURL(),
              NEXT_PUBLIC_ADMIN_URL: adminBaseURL(),
              NEXT_PUBLIC_STOREFRONT_URL: storefrontBaseURL(),
              // Node-side fixtures still use the Docker service URL. Browser
              // traffic must stay on the admin origin and pass through Next's
              // E2E-only rewrite so every engine observes the same CORS policy.
              NEXT_PUBLIC_API_BASE_URL: browserApiURL(),
              NEXT_PUBLIC_API_URL: browserApiURL(),
              NEXT_PUBLIC_IMAGE_BASE_URL: browserImageOrigin(),
              NEXT_PUBLIC_AUTH_ENVIRONMENT: "e2e",
              NEXT_PUBLIC_AUTH_ORIGIN: centralAuthOrigin(),
              NEXT_PUBLIC_AUTH_URL: centralAuthOrigin(),
              AUTH_SERVER_ORIGIN: centralAuthOrigin(),
            },
          },
        ]
      : []),
  ],
});
