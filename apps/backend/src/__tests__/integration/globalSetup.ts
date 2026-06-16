/**
 * Jest globalSetup for the backend integration layer (runs once, parent process).
 *
 * Responsibilities:
 *  1. Force a safe test env (NODE_ENV=test, dummy Strapi secrets, background jobs OFF).
 *  2. Provision a REAL, disposable Postgres — a Testcontainers container by default,
 *     or a CI-provided `services:` Postgres when INTEGRATION_DB_MODE=service.
 *  3. Run hard safety guards so we never point at staging/production.
 *  4. Publish the connection to the test files via process.env + a temp file.
 *  5. Compile the TS project to `dist` ONCE so each test file can boot Strapi
 *     without paying the tsc cost again.
 *
 * The container handle is stashed on globalThis so globalTeardown (same parent
 * process) can stop it.
 */
import fs from "fs";
import path from "path";
import { assertSafeIntegrationTarget } from "./safety";
import { CONN_FILE, DB_MODE, PG_IMAGE, type IntegrationDbConnection } from "./env";

const APP_DIR = path.resolve(__dirname, "..", "..", "..");

function setEnvDefaults() {
  process.env.NODE_ENV = "test";
  // Strapi refuses to boot without these — values are throwaway test secrets.
  process.env.APP_KEYS = process.env.APP_KEYS || "testKeyA,testKeyB";
  process.env.API_TOKEN_SALT = process.env.API_TOKEN_SALT || "test-api-token-salt";
  process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "test-admin-jwt-secret";
  process.env.TRANSFER_TOKEN_SALT = process.env.TRANSFER_TOKEN_SALT || "test-transfer-salt";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
  // Keep boot lean & deterministic: no periodic jobs, no telemetry, no Redis,
  // and skip the slow idempotent app seeding (see src/index.ts bootstrap guard).
  process.env.DISABLE_BACKGROUND_JOBS = "true";
  process.env.SKIP_BOOTSTRAP_SEED = "true";
  process.env.SENTRY_DSN = "";
  process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
}

async function provisionDatabase(): Promise<IntegrationDbConnection> {
  if (DB_MODE === "service") {
    // CI provided a Postgres service container; read its connection from env.
    return {
      host: process.env.DATABASE_HOST || "localhost",
      port: Number(process.env.DATABASE_PORT || 5432),
      database: process.env.DATABASE_NAME || "test",
      username: process.env.DATABASE_USERNAME || "test",
      password: process.env.DATABASE_PASSWORD || "test",
    };
  }

  // Default: spin up a disposable container.
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer(PG_IMAGE)
    .withDatabase("infinity_test")
    .withUsername("infinity_test")
    .withPassword("infinity_test")
    .start();

  (globalThis as any).__PG_CONTAINER__ = container;

  return {
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: container.getPassword(),
  };
}

function publishConnection(conn: IntegrationDbConnection) {
  process.env.DATABASE_CLIENT = "postgres";
  process.env.DATABASE_HOST = conn.host;
  process.env.DATABASE_PORT = String(conn.port);
  process.env.DATABASE_NAME = conn.database;
  process.env.DATABASE_USERNAME = conn.username;
  process.env.DATABASE_PASSWORD = conn.password;
  process.env.DATABASE_SSL = "false";
  // Keep the pool tiny and allow it to drain to 0 so Jest can exit cleanly.
  process.env.DATABASE_POOL_MIN = "0";
  process.env.DATABASE_POOL_MAX = "5";
  delete process.env.DATABASE_URL; // avoid connectionString overriding host/port
  fs.writeFileSync(CONN_FILE, JSON.stringify(conn), "utf8");
}

async function compileOnce() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const strapi = require("@strapi/strapi");
  const { distDir } = await strapi.compile({ appDir: APP_DIR, ignoreDiagnostics: true });
  process.env.INTEGRATION_APP_DIR = APP_DIR;
  process.env.INTEGRATION_DIST_DIR = distDir;
}

export default async function globalSetup() {
  setEnvDefaults();
  const conn = await provisionDatabase();
  assertSafeIntegrationTarget(conn);
  publishConnection(conn);
  await compileOnce();
}
