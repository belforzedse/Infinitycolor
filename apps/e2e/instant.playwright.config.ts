import { defineConfig, devices } from "@playwright/test";

const storefrontBaseURL = process.env.E2E_BASE_URL || "http://localhost:2888";
const socialBaseURL = process.env.SOCIAL_E2E_BASE_URL || "http://localhost:2890";
const externalServers = Boolean(process.env.E2E_BASE_URL || process.env.SOCIAL_E2E_BASE_URL);
const storefrontTestEnv =
  "NEXT_INSTANT_TESTS=true NEXT_PUBLIC_AUTH_ENVIRONMENT=e2e NEXT_PUBLIC_AUTH_ORIGIN=http://localhost:2889 AUTH_SERVER_ORIGIN=http://localhost:2889 NEXT_PUBLIC_API_BASE_URL=http://localhost:1337/api NEXT_PUBLIC_API_URL=http://localhost:1337/api NEXT_PUBLIC_SITE_URL=http://localhost:2888 NEXT_PUBLIC_STOREFRONT_URL=http://localhost:2888 STRAPI_INTERNAL_URL=http://localhost:1337/api STRAPI_BUILD_TIME_URL=http://localhost:1337/api";

function standaloneCommand(
  appFilter: string,
  appDir: string,
  port: number,
  buildEnvironment: string,
) {
  const standaloneDir = `apps/${appDir}/.next/standalone`;
  const runtimeAppDir = `${standaloneDir}/apps/${appDir}`;

  return [
    `${buildEnvironment} pnpm --filter ${appFilter} build`,
    `rm -rf ${runtimeAppDir}/.next/static ${runtimeAppDir}/public`,
    `mkdir -p ${runtimeAppDir}/.next/static ${runtimeAppDir}/public`,
    `cp -R apps/${appDir}/.next/static/. ${runtimeAppDir}/.next/static/`,
    `cp -R apps/${appDir}/public/. ${runtimeAppDir}/public/`,
    `${buildEnvironment} HOSTNAME=127.0.0.1 PORT=${port} node ${runtimeAppDir}/server.js`,
  ].join(" && ");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "instant-navigation.spec.ts",
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "dot" : "list",
  projects: [
    {
      name: "storefront-instant",
      use: { ...devices["Desktop Chrome"], baseURL: storefrontBaseURL },
    },
    {
      name: "social-instant",
      use: { ...devices["Desktop Chrome"], baseURL: socialBaseURL },
    },
  ],
  webServer: externalServers
    ? undefined
    : [
        {
          command: standaloneCommand(
            "@repo/frontend",
            "frontend",
            2888,
            storefrontTestEnv,
          ),
          cwd: "../..",
          url: storefrontBaseURL,
          timeout: 180_000,
          reuseExistingServer: true,
        },
        {
          command: standaloneCommand(
            "@repo/social",
            "social",
            2890,
            "NEXT_INSTANT_TESTS=true NEXT_PUBLIC_SOCIAL_HOME_POSTS_DEMO=true",
          ),
          cwd: "../..",
          url: socialBaseURL,
          timeout: 180_000,
          reuseExistingServer: true,
        },
      ],
});
