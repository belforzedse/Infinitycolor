import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cp } from "node:fs/promises";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const frontend = path.join(root, "apps/frontend");
const env = {
  ...process.env,
  NEXT_BUILD_DIR: ".next-color-gallery-check",
  NEXT_TELEMETRY_DISABLED: "1",
  SENTRY_AUTH_TOKEN: "",
  SENTRY_DSN: "",
  NEXT_PUBLIC_SENTRY_DSN: "",
  NEXT_PUBLIC_STRAPI_TOKEN: "",
  FRONTEND_REDIS_URL: "",
  REDIS_URL: "",
  NEXT_CACHE_ENVIRONMENT: "gallery-check",
  NEXT_PUBLIC_AUTH_ENVIRONMENT: "e2e",
  NEXT_PUBLIC_AUTH_ORIGIN: "http://localhost:2889",
  AUTH_SERVER_ORIGIN: "http://localhost:2889",
  NEXT_PUBLIC_MEDIA_CDN_URL: "",
  NEXT_PUBLIC_API_BASE_URL: "http://localhost:4310/api",
  NEXT_PUBLIC_API_URL: "http://localhost:4310/api",
  E2E_API_PROXY_TARGET: "http://localhost:4311",
  STRAPI_INTERNAL_URL: "http://localhost:4311/api",
  STRAPI_BUILD_TIME_URL: "http://localhost:4311/api",
  NEXT_PUBLIC_IMAGE_BASE_URL: "https://gallery-fixture.example",
  NEXT_PUBLIC_SITE_URL: "http://localhost:4310",
  NEXT_PUBLIC_STOREFRONT_URL: "http://localhost:4310",
};
const fixture = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL("./product-color-gallery-fixture.mjs", import.meta.url),
    ),
  ],
  { env, stdio: "inherit", windowsHide: true },
);
const next = path.join(frontend, "node_modules/next/dist/bin/next");
const run = (args) =>
  spawn(process.execPath, [next, ...args], {
    cwd: frontend,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
let server;
const cleanup = () => {
  fixture.kill();
  server?.kill();
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
process.on("exit", cleanup);
if (process.env.GALLERY_E2E_SKIP_BUILD !== "true") {
  const build = run(["build"]);
  const code = await new Promise((resolve) => build.once("exit", resolve));
  if (code !== 0) {
    cleanup();
    process.exit(code || 1);
  }
}
const buildDir = path.join(frontend, env.NEXT_BUILD_DIR);
const runtimeDir = path.join(buildDir, "standalone/apps/frontend");
await cp(path.join(frontend, "public"), path.join(runtimeDir, "public"), {
  recursive: true,
});
await cp(
  path.join(buildDir, "static"),
  path.join(runtimeDir, env.NEXT_BUILD_DIR, "static"),
  { recursive: true },
);
server = spawn(process.execPath, [path.join(runtimeDir, "server.js")], {
  cwd: runtimeDir,
  env: { ...env, PORT: "4310", HOSTNAME: "127.0.0.1" },
  stdio: "inherit",
  windowsHide: true,
});
server.once("exit", (code) => {
  cleanup();
  process.exit(code || 0);
});
