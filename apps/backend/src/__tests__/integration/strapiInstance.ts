/**
 * Boots a REAL Strapi instance for integration tests.
 *
 * Jest sandboxes each test file's `global`, so the instance compiled/booted in
 * `globalSetup` cannot be shared across the boundary. Instead globalSetup
 * compiles the project to `dist` once, and each test file boots from that
 * prebuilt `dist` via `setupStrapi()` in a `beforeAll`. The instance is
 * memoized per file and torn down with `teardownStrapi()` in `afterAll`.
 */
import fs from "fs";
import path from "path";
import { CONN_FILE } from "./env";

let instance: any = null;

/** Ensure DATABASE_* are present even if process.env wasn't inherited. */
function ensureDbEnv() {
  if (process.env.DATABASE_HOST && process.env.DATABASE_PORT) return;
  if (!fs.existsSync(CONN_FILE)) return;
  const conn = JSON.parse(fs.readFileSync(CONN_FILE, "utf8"));
  process.env.DATABASE_CLIENT = "postgres";
  process.env.DATABASE_HOST = conn.host;
  process.env.DATABASE_PORT = String(conn.port);
  process.env.DATABASE_NAME = conn.database;
  process.env.DATABASE_USERNAME = conn.username;
  process.env.DATABASE_PASSWORD = conn.password;
  process.env.DATABASE_SSL = "false";
}

export async function setupStrapi(): Promise<any> {
  if (instance) return instance;
  ensureDbEnv();

  const appDir = process.env.INTEGRATION_APP_DIR || path.resolve(__dirname, "..", "..", "..");
  const distDir = process.env.INTEGRATION_DIST_DIR || path.join(appDir, "dist");

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const strapiFactory = require("@strapi/strapi");
  instance = strapiFactory({ appDir, distDir, autoReload: false, serveAdminPanel: false });
  await instance.load();
  (global as any).strapi = instance;
  return instance;
}

export function getStrapi(): any {
  if (!instance) throw new Error("Strapi is not booted. Call setupStrapi() in beforeAll.");
  return instance;
}

export async function teardownStrapi(): Promise<void> {
  if (!instance) return;
  try {
    await instance.destroy();
  } finally {
    instance = null;
    (global as any).strapi = undefined;
  }
}
