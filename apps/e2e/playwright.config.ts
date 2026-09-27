import { defineConfig, devices } from "@playwright/test";
import {
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
  // Specs another config owns: each starts its own servers or sets its own
  // build flags, so collecting them here ran them against the wrong stack.
  // Admin CRUD -> admin config; the analytics wire test -> analytics config
  // (storefront built against a stub collector); stories -> stories config
  // (component harness); staging journeys -> staging config (a deployed
  // environment); the rest -> their adaptive/parity/instant/defects configs.
  testIgnore: [
    "super-admin/**/*.spec.ts",
    "analytics/**/*.spec.ts",
    "stories/**/*.spec.ts",
    "staging/**/*.spec.ts",
    "instant-navigation.spec.ts",
    "storefront/adaptive-quality.spec.ts",
    "storefront/static-parity.spec.ts",
    "storefront/forced-low-static-parity.spec.ts",
    "storefront/defects2.spec.ts",
  ],
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
      // Tests tagged @api drive no browser; one run on desktop is enough.
      grepInvert: /@api\b/,
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
            ...webServerOutput,
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
            ...webServerOutput,
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
