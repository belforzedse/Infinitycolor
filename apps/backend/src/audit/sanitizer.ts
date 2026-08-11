import { redactSensitive } from "../utils/redactSensitive";
import type { AuditFieldChange, AuditJobContext } from "./types";

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_ARRAY = 100;
const MAX_KEYS = 80;
const MAX_STRING = 2_000;
const MAX_JSON_BYTES = 64 * 1024;

const SECRET_IN_URL = /([?&](?:token|key|secret|password|otp|code|signature|session)[^=]*=)[^&#\s]*/gi;
const BEARER = /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;
const CARD = /\b(?:\d[ -]*?){13,19}\b/g;

function sanitizeString(value: string): string {
  const clean = value
    .replace(SECRET_IN_URL, `$1${REDACTED}`)
    .replace(BEARER, REDACTED)
    .replace(JWT, REDACTED)
    .replace(CARD, REDACTED);
  return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…[truncated]` : clean;
}

function bound(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[max-depth]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => bound(item, depth + 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
    result[key] = bound(nested, depth + 1, seen);
  }
  return result;
}

export function sanitizeAuditValue<T>(value: T): T {
  const redacted = redactSensitive(value);
  const bounded = bound(redacted, 0, new WeakSet()) as T;
  const encoded = JSON.stringify(bounded);
  const byteLength = Buffer.byteLength(encoded, "utf8");
  if (byteLength <= MAX_JSON_BYTES) return bounded;
  return { truncated: true, byteLength } as T;
}

export function normalizeAuditChanges(
  changes: AuditFieldChange[] | Record<string, { from?: unknown; to?: unknown }> | null | undefined,
): AuditFieldChange[] {
  if (!changes) return [];
  const normalized = Array.isArray(changes)
    ? changes
    : Object.entries(changes).map(([field, value]) => ({ field, from: value?.from, to: value?.to }));
  const sanitized = sanitizeAuditValue(normalized);
  return Array.isArray(sanitized)
    ? sanitized.filter((change) => change && typeof change.field === "string")
    : [];
}

export function sanitizeRequestIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ip = value.split(",")[0]?.trim();
  if (!ip || ip.length > 64 || !/^[0-9a-f:.]+$/i.test(ip)) return null;
  return ip;
}

export function sanitizeUserAgent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return sanitizeString(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 512) || null;
}

export function serializeAuditJobContext(context: AuditJobContext): AuditJobContext {
  return sanitizeAuditValue({
    schemaVersion: 1,
    initiator: {
      type: context.initiator.type,
      id: context.initiator.id == null ? undefined : String(context.initiator.id),
      label: context.initiator.label || undefined,
      role: context.initiator.role || undefined,
      roleId: context.initiator.roleId == null ? undefined : String(context.initiator.roleId),
    },
    origin: context.origin,
    requestId: context.requestId,
    interactionId: context.interactionId,
    correlationId: context.correlationId,
    rootEventId: context.rootEventId,
    parentEventId: context.parentEventId,
    batchId: context.batchId,
    causationId: context.causationId,
    traceId: context.traceId,
  });
}
