import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  deliverAuthAuditOutbox,
  recordAdminLoginFailure,
  recordAdminSessionCreated,
} from "./server/audit-outbox";
import { resetAuthEnvForTests } from "./server/env";

process.env.AUTH_FLOW_SECRET = "test-only-auth-flow-secret-that-is-long-enough";

const adminIdentity = {
  ok: true as const,
  confirmed: true,
  strapiUserId: 42,
  sessionVersion: 1,
  admin: {
    label: "سارا محمدی",
    roleId: "6",
    roleName: "Finance administrator",
  },
};

function payloadFromQuery(parameters: unknown[] | undefined): Record<string, any> {
  assert.ok(parameters);
  const payload = JSON.parse(String(parameters[1]));
  assert.equal(typeof payload, "object");
  return payload;
}

test("admin login outbox snapshots responsibility without storing a session token", async () => {
  const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  const client = {
    async query(sql: string, parameters?: unknown[]) {
      queries.push({ sql, parameters });
      return { rows: [] };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { async connect() { return client; } } as unknown as Pool;

  await recordAdminSessionCreated(pool, {
    sessionId: "opaque-session-id-that-must-not-leave-auth",
    identity: adminIdentity,
    requestId: "request-auth-12345",
    ipAddress: "203.0.113.9",
    userAgent: "Infinity Admin Browser",
  });

  const insert = queries.find((entry) => entry.sql.includes("auth_audit_outbox"));
  const payload = payloadFromQuery(insert?.parameters);
  assert.deepEqual(payload.actor, {
    type: "service_account",
    id: "infinity-auth",
    label: "Infinity Auth",
  });
  assert.deepEqual(payload.initiator, {
    type: "human",
    id: "42",
    label: "سارا محمدی",
    role: "Finance administrator",
    roleId: "6",
  });
  assert.equal(payload.origin, "admin_ui");
  assert.equal(payload.ip, "203.0.113.9");
  assert.equal(payload.userAgent, "Infinity Admin Browser");
  assert.notEqual(payload.metadata.sessionTag, "opaque-session-id-that-must-not-leave-auth");
  assert.equal(JSON.stringify(payload).includes("opaque-session-id-that-must-not-leave-auth"), false);
  assert.deepEqual(queries.map((entry) => entry.sql.trim().split(/\s+/).slice(0, 2).join(" ")), [
    "begin",
    "insert into",
    "insert into",
    "commit",
  ]);
});

test("failed admin login stores only a keyed subject tag", async () => {
  let captured: Record<string, any> | null = null;
  const pool = {
    async query(_sql: string, parameters?: unknown[]) {
      captured = payloadFromQuery(parameters);
      return { rows: [] };
    },
  } as unknown as Pool;
  const phone = "09120000000";

  await recordAdminLoginFailure(pool, {
    subject: phone,
    reasonCode: "INVALID_CREDENTIALS",
    requestId: "request-auth-failed-123",
  });

  const failedPayload = captured as Record<string, any> | null;
  assert.ok(failedPayload);
  assert.equal(JSON.stringify(failedPayload).includes(phone), false);
  assert.equal(failedPayload.eventKey, "authentication.login_failed");
  assert.equal(failedPayload.initiator.type, "unknown");
  assert.equal(failedPayload.metadata.subjectTag, failedPayload.initiator.id);
  assert.equal(failedPayload.dedupeKey, "auth:login-failed:request-auth-failed-123");
});

test("delivery failure releases the lease and applies bounded retry backoff", async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    AUTH_DEPLOYMENT_ENV: "development",
    BETTER_AUTH_URL: "http://localhost:2889",
    BETTER_AUTH_SECRET: "test-only-better-auth-secret-long-enough",
    AUTH_DATABASE_URL: "postgresql://unused/unused",
    AUTH_TRUSTED_STOREFRONT_ORIGINS: "http://localhost:2888",
    AUTH_DEFAULT_STOREFRONT_ORIGIN: "http://localhost:2888",
    AUTH_TRUSTED_ADMIN_ORIGINS: "http://localhost:2891",
    STRAPI_INTERNAL_URL: "http://localhost:1337",
    AUTH_STRAPI_BRIDGE_SECRET: "test-only-bridge-secret-that-is-long-enough",
    AUTH_JWT_ISSUER: "http://localhost:2889",
    AUTH_JWT_AUDIENCE: "http://localhost:1337",
    AUTH_JWT_TTL_SECONDS: "60",
    AUTH_JWKS_ROTATION_SECONDS: "2592000",
    AUTH_JWKS_GRACE_SECONDS: "86400",
    AUTH_SESSION_TTL_SECONDS: "604800",
  });
  resetAuthEnvForTests();
  const updates: Array<{ sql: string; parameters?: unknown[] }> = [];
  let call = 0;
  const pool = {
    async query(sql: string, parameters?: unknown[]) {
      call += 1;
      if (call === 1) {
        return {
          rows: [{
            id: "17",
            attempts: 2,
            payload: {
              eventKey: "authentication.login_succeeded",
              result: "success",
              actor: { type: "service_account", id: "infinity-auth", label: "Infinity Auth" },
              initiator: { type: "human", id: "42" },
              origin: "admin_ui",
              occurredAt: "2026-08-11T08:00:00.000Z",
              dedupeKey: "auth:login:example",
            },
          }],
        };
      }
      updates.push({ sql, parameters });
      return { rows: [] };
    },
  } as unknown as Pool;

  const delivered = await deliverAuthAuditOutbox(
    pool,
    (async () => new Response(null, { status: 503 })) as typeof fetch,
  );

  assert.equal(delivered, 0);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /available_at = now\(\)/);
  assert.deepEqual(updates[0].parameters?.slice(0, 2), [["17"], "20"]);
});
