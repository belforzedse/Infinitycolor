import assert from "node:assert/strict";
import test from "node:test";
import { resetAuthEnvForTests } from "./server/env";
import { getAuthPool } from "./server/database";

test("production reuses one database pool across calls", async () => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    AUTH_DEPLOYMENT_ENV: "production",
    BETTER_AUTH_URL: "https://auth.infinitycolor.co",
    BETTER_AUTH_SECRET: "a".repeat(32),
    AUTH_DATABASE_URL: "postgresql://unused/unused",
    AUTH_FLOW_SECRET: "f".repeat(32),
    AUTH_TRUSTED_ADMIN_ORIGINS: "https://admin.infinitycolor.co",
    AUTH_TRUSTED_STOREFRONT_ORIGINS:
      "https://new.infinitycolor.co,https://infinitycolor.co,https://infinitygram.co",
    AUTH_DEFAULT_STOREFRONT_ORIGIN: "https://new.infinitycolor.co",
    STRAPI_INTERNAL_URL: "https://api.infinitycolor.co",
    AUTH_STRAPI_BRIDGE_SECRET: "b".repeat(32),
    AUTH_JWT_ISSUER: "https://auth.infinitycolor.co",
    AUTH_JWT_AUDIENCE: "https://api.infinitycolor.co",
    AUTH_JWT_TTL_SECONDS: "60",
    AUTH_JWKS_ROTATION_SECONDS: "2592000",
    AUTH_JWKS_GRACE_SECONDS: "86400",
    AUTH_SESSION_TTL_SECONDS: "604800",
  });
  resetAuthEnvForTests();
  globalThis.__infinityAuthPool = undefined;

  // The readiness route calls getAuthPool() per request. A new pool per call
  // leaves one idle connection behind for each probe hit.
  const pool = getAuthPool();
  try {
    assert.equal(getAuthPool(), pool);
  } finally {
    globalThis.__infinityAuthPool = undefined;
    await pool.end();
  }
});
