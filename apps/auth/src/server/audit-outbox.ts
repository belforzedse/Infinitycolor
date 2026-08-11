import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createBridgeHeaders } from "@repo/auth-core/bridge-signature";
import type { BridgeVerifiedIdentityResponse } from "@repo/auth-core/contracts";
import { getAuthEnv } from "./env";
import { keyedSubjectTag } from "./event-logger";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type AuditPayload = {
  eventKey: string;
  result: "success" | "failure" | "denied";
  actor: { type: "service_account"; id: string; label: string };
  initiator: {
    type: "human" | "unknown";
    id?: string;
    label?: string;
    role?: string;
    roleId?: string;
  };
  origin: "admin_ui";
  target?: { type: "administrator"; id?: string; label?: string };
  reasonCode?: string;
  requestId?: string;
  correlationId?: string;
  ip?: string | null;
  userAgent?: string | null;
  occurredAt: string;
  metadata?: Record<string, string>;
  dedupeKey: string;
};

type LeasedRow = { id: string; payload: AuditPayload; attempts: number };

const LOOP_INTERVAL_MS = 15_000;
const DELIVERY_PATH = "/api/internal/audit/events";

declare global {
  // eslint-disable-next-line no-var
  var __infinityAuthAuditTimer: ReturnType<typeof setInterval> | undefined;
}

function serviceActor(): AuditPayload["actor"] {
  return { type: "service_account", id: "infinity-auth", label: "Infinity Auth" };
}

export function isAdminReturnTarget(returnTo: string): boolean {
  try {
    return getAuthEnv().trustedAdminOrigins.includes(new URL(returnTo).origin);
  } catch {
    return false;
  }
}

export async function enqueueAuthAuditEvent(
  database: Queryable,
  payload: AuditPayload,
): Promise<void> {
  await database.query(
    `insert into auth.auth_audit_outbox (dedupe_key, payload, occurred_at)
     values ($1, $2::jsonb, $3::timestamptz)
     on conflict (dedupe_key) do nothing`,
    [payload.dedupeKey, JSON.stringify(payload), payload.occurredAt],
  );
}

export async function recordAdminSessionCreated(
  pool: Pool,
  input: {
    sessionId: string;
    identity: BridgeVerifiedIdentityResponse;
    requestId?: string;
    userAgent?: string | null;
    ipAddress?: string | null;
  },
): Promise<void> {
  if (!input.identity.admin) return;
  const client = await pool.connect();
  const now = new Date().toISOString();
  const sessionTag = keyedSubjectTag(input.sessionId);
  const dedupeKey = `auth:login:${sessionTag}`;
  try {
    await client.query("begin");
    await client.query(
      `insert into auth.admin_session_audit_contexts
        (session_id, strapi_user_id, initiator_label, initiator_role_id, initiator_role_name, origin)
       values ($1, $2, $3, $4, $5, 'admin_ui')
       on conflict (session_id) do nothing`,
      [
        input.sessionId,
        input.identity.strapiUserId,
        input.identity.admin.label,
        input.identity.admin.roleId,
        input.identity.admin.roleName,
      ],
    );
    await enqueueAuthAuditEvent(client, {
      eventKey: "authentication.login_succeeded",
      result: "success",
      actor: serviceActor(),
      initiator: {
        type: "human",
        id: String(input.identity.strapiUserId),
        label: input.identity.admin.label,
        role: input.identity.admin.roleName,
        roleId: input.identity.admin.roleId,
      },
      origin: "admin_ui",
      target: {
        type: "administrator",
        id: String(input.identity.strapiUserId),
        label: input.identity.admin.label,
      },
      requestId: input.requestId,
      correlationId: input.requestId,
      ip: input.ipAddress,
      userAgent: input.userAgent,
      occurredAt: now,
      metadata: {
        sessionTag,
      },
      dedupeKey,
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordAdminLoginFailure(
  pool: Pool,
  input: { subject: string; reasonCode: string; requestId?: string },
): Promise<void> {
  const now = new Date().toISOString();
  const subjectTag = keyedSubjectTag(input.subject);
  await enqueueAuthAuditEvent(pool, {
    eventKey: "authentication.login_failed",
    result: "failure",
    actor: serviceActor(),
    initiator: { type: "unknown", id: subjectTag, label: "تلاش‌کننده ناشناس" },
    origin: "admin_ui",
    reasonCode: input.reasonCode.slice(0, 120),
    requestId: input.requestId,
    correlationId: input.requestId,
    occurredAt: now,
    metadata: { subjectTag },
    dedupeKey: `auth:login-failed:${input.requestId || randomUUID()}`,
  });
}

export async function recordAdminSecurityChange(
  pool: Pool,
  input: { identity: BridgeVerifiedIdentityResponse; reasonCode: string; requestId?: string },
): Promise<void> {
  if (!input.identity.admin) return;
  const now = new Date().toISOString();
  await enqueueAuthAuditEvent(pool, {
    eventKey: "authentication.security_changed",
    result: "success",
    actor: serviceActor(),
    initiator: {
      type: "human",
      id: String(input.identity.strapiUserId),
      label: input.identity.admin.label,
      role: input.identity.admin.roleName,
      roleId: input.identity.admin.roleId,
    },
    origin: "admin_ui",
    target: {
      type: "administrator",
      id: String(input.identity.strapiUserId),
      label: input.identity.admin.label,
    },
    reasonCode: input.reasonCode,
    requestId: input.requestId,
    correlationId: input.requestId,
    occurredAt: now,
    dedupeKey: `auth:security:${input.reasonCode}:${input.requestId || randomUUID()}`,
  });
}

async function leaseBatch(pool: Pool): Promise<LeasedRow[]> {
  const result = await pool.query<LeasedRow>(
    `with candidates as (
       select id from auth.auth_audit_outbox
        where delivered_at is null
          and available_at <= now()
          and (lease_until is null or lease_until < now())
        order by id
        for update skip locked
        limit 50
     )
     update auth.auth_audit_outbox as outbox
        set lease_until = now() + interval '1 minute', attempts = attempts + 1
       from candidates
      where outbox.id = candidates.id
      returning outbox.id::text, outbox.payload, outbox.attempts`,
  );
  return result.rows;
}

export async function deliverAuthAuditOutbox(
  pool: Pool,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const rows = await leaseBatch(pool);
  if (!rows.length) return 0;
  const env = getAuthEnv();
  const body = { events: rows.map((row) => row.payload) };
  const signed = createBridgeHeaders(env.bridgeSecret, "POST", DELIVERY_PATH, body);
  try {
    const response = await fetchImpl(`${env.strapiInternalUrl}${DELIVERY_PATH}`, {
      method: "POST",
      headers: { ...signed.headers, accept: "application/json" },
      body: signed.body,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`AUDIT_BRIDGE_${response.status}`);
    await pool.query(
      `update auth.auth_audit_outbox
          set delivered_at = now(), lease_until = null, last_error = null
        where id = any($1::bigint[])`,
      [rows.map((row) => row.id)],
    );
    await pool.query(
      `delete from auth.auth_audit_outbox
        where delivered_at < now() - interval '7 days'`,
    );
    return rows.length;
  } catch (error) {
    const reasonCode = error instanceof Error ? error.message.slice(0, 120) : "AUDIT_DELIVERY_FAILED";
    const backoffSeconds = Math.min(3_600, 5 * (2 ** Math.min(Math.max(...rows.map((row) => row.attempts)), 9)));
    await pool.query(
      `update auth.auth_audit_outbox
          set lease_until = null,
              available_at = now() + ($2::text || ' seconds')::interval,
              last_error = $3
        where id = any($1::bigint[])`,
      [rows.map((row) => row.id), String(backoffSeconds), reasonCode],
    );
    console.error(JSON.stringify({ event: "auth_audit_delivery_failed", reasonCode, count: rows.length }));
    return 0;
  }
}

export function kickAuthAuditDelivery(pool: Pool): void {
  void deliverAuthAuditOutbox(pool).catch((error) => {
    console.error(JSON.stringify({
      event: "auth_audit_delivery_failed",
      reasonCode: error instanceof Error ? error.name : "UNKNOWN",
    }));
  });
}

export function startAuthAuditDeliveryLoop(pool: Pool): void {
  if (process.env.NODE_ENV === "test" || globalThis.__infinityAuthAuditTimer) return;
  kickAuthAuditDelivery(pool);
  const timer = setInterval(() => kickAuthAuditDelivery(pool), LOOP_INTERVAL_MS);
  timer.unref?.();
  globalThis.__infinityAuthAuditTimer = timer;
}
