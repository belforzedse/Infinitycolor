import type { Strapi } from "@strapi/strapi";

import { normalizeAuditChanges, sanitizeAuditValue } from "./sanitizer";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_IMPORTANCE,
  AUDIT_RESULTS,
  AUDIT_ORIGINS,
  isHumanActor,
  type AuditCursorPage,
  type AuditEventRecord,
  type AuditQuery,
  type AuditSummary,
} from "./types";

const TABLE = "manual_admin_activities";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_SEARCH = 160;

type Cursor = { occurredAt: string; id: number };

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor?: string): Cursor | null {
  if (!cursor || cursor.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const occurredAt = new Date(parsed?.occurredAt);
    const id = Number(parsed?.id);
    if (Number.isNaN(occurredAt.getTime()) || !Number.isSafeInteger(id) || id <= 0) return null;
    return { occurredAt: occurredAt.toISOString(), id };
  } catch {
    return null;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function selectColumns(query: any): any {
  return query.select([
    "id", "event_id", "schema_version", "occurred_at", "recorded_at", "event_key",
    "domain", "operation", "importance", "result_status", "initiator_type", "initiator_id",
    "initiator_label", "initiator_role_id", "initiator_role_name", "actor_type", "actor_id",
    "actor_label", "actor_role_id", "actor_role_name", "actor_auth_method", "origin",
    "target_type", "target_id", "target_label", "target_snapshot",
    "related_type", "related_id", "related_label", "related_snapshot", "root_event_id",
    "parent_event_id", "request_id", "interaction_id", "correlation_id", "causation_id", "trace_id",
    "job_id", "batch_id", "environment", "service_name", "scope",
    "route", "http_method", "reason_code", "changes", "metadata", "title", "message",
    "message_en", "description", "ip", "user_agent", "resource_type", "resource_id",
    "action", "performed_by_name", "performed_by_role", "created_at",
  ]);
}

function applyFilters(query: any, filters: AuditQuery, includeMode = true): any {
  const from = dateOrNull(filters.from);
  const to = dateOrNull(filters.to);
  if (from) query.where("occurred_at", ">=", from);
  if (to) query.where("occurred_at", "<=", to);
  if (includeMode && filters.mode === "human") query.whereIn("actor_type", ["human", "impersonated_human"]);
  if (includeMode && filters.mode === "automatic") query.whereNotIn("actor_type", ["human", "impersonated_human"]);
  if (filters.initiatorId) query.where("initiator_id", filters.initiatorId);
  if (filters.actorType && AUDIT_ACTOR_TYPES.includes(filters.actorType)) {
    query.where("actor_type", filters.actorType);
  }
  if (filters.role) {
    query.where((builder: any) => builder.where("actor_role_id", filters.role).orWhere("actor_role_name", filters.role));
  }
  if (filters.origin && AUDIT_ORIGINS.includes(filters.origin)) query.where("origin", filters.origin);
  if (filters.domain) query.where("domain", filters.domain);
  if (filters.eventKey) query.where("event_key", filters.eventKey);
  if (filters.targetType) query.where("target_type", filters.targetType);
  if (filters.targetId) query.where("target_id", filters.targetId);
  if (filters.result && AUDIT_RESULTS.includes(filters.result)) query.where("result_status", filters.result);
  if (filters.importance && AUDIT_IMPORTANCE.includes(filters.importance)) query.where("importance", filters.importance);
  if (filters.correlationId) query.where("correlation_id", filters.correlationId);
  if (filters.rootEventId) query.where("root_event_id", filters.rootEventId);
  const search = filters.search?.trim().slice(0, MAX_SEARCH);
  if (search) query.whereILike("search_text", `%${escapeLike(search)}%`);
  return query;
}

export function mapAuditRow(row: any): AuditEventRecord {
  const eventId = row.event_id || `legacy-${row.id}`;
  const actorType = row.actor_type || (row.performed_by_name ? "human" : "unknown");
  const initiatorType = row.initiator_type || (row.performed_by_name ? "human" : "unknown");
  const revealsHumanOrigin =
    isHumanActor(actorType) ||
    String(row.event_key || "").startsWith("authentication.") ||
    row.event_key === "security.access_denied";
  const changes = normalizeAuditChanges(parseJson(row.changes, null));
  return {
    id: Number(row.id),
    eventId,
    schemaVersion: Number(row.schema_version || 1),
    occurredAt: new Date(row.occurred_at || row.created_at).toISOString(),
    recordedAt: new Date(row.recorded_at || row.created_at).toISOString(),
    eventKey: row.event_key || "legacy.activity",
    domain: row.domain || String(row.resource_type || "legacy").toLowerCase(),
    operation: row.operation || String(row.action || "other").toLowerCase(),
    importance: row.importance || (row.severity === "error" ? "important" : "normal"),
    result: row.result_status || (row.severity === "error" ? "failure" : "success"),
    mode: isHumanActor(actorType) ? "human" : "automatic",
    initiator: {
      type: initiatorType,
      id: row.initiator_id || undefined,
      label: row.initiator_label || row.performed_by_name || undefined,
      role: row.initiator_role_name || row.performed_by_role || undefined,
      roleId: row.initiator_role_id || undefined,
    },
    actor: {
      type: actorType,
      id: row.actor_id || undefined,
      label: row.actor_label || (actorType === "human" ? row.performed_by_name : undefined),
      role: row.actor_role_name || row.performed_by_role || undefined,
      roleId: row.actor_role_id || undefined,
      authMethod: row.actor_auth_method || undefined,
    },
    origin: row.origin || "legacy",
    target: row.target_type || row.resource_type ? {
      type: row.target_type || String(row.resource_type).toLowerCase(),
      id: row.target_id || row.resource_id || undefined,
      label: row.target_label || row.resource_id || undefined,
      snapshot: sanitizeAuditValue(parseJson(row.target_snapshot, null)),
    } : null,
    related: row.related_type ? {
      type: row.related_type,
      id: row.related_id || undefined,
      label: row.related_label || undefined,
      snapshot: sanitizeAuditValue(parseJson(row.related_snapshot, null)),
    } : null,
    changes,
    metadata: sanitizeAuditValue(parseJson(row.metadata, null)),
    summaryFa: row.message || row.title || "فعالیت ثبت‌شده",
    summaryEn: row.message_en || null,
    reasonCode: row.reason_code || null,
    rootEventId: row.root_event_id || eventId,
    parentEventId: row.parent_event_id || null,
    requestId: row.request_id || null,
    interactionId: row.interaction_id || null,
    correlationId: row.correlation_id || null,
    causationId: row.causation_id || null,
    traceId: row.trace_id || null,
    jobId: row.job_id || null,
    batchId: row.batch_id || null,
    route: row.route || null,
    httpMethod: row.http_method || null,
    ip: revealsHumanOrigin ? row.ip || null : null,
    userAgent: revealsHumanOrigin ? row.user_agent || null : null,
    environment: row.environment || null,
    service: row.service_name || null,
    scope: sanitizeAuditValue(parseJson(row.scope, null)),
    legacy: Number(row.schema_version || 1) === 1,
  } as AuditEventRecord;
}

export async function findAuditEvents(
  strapi: Strapi,
  filters: AuditQuery,
): Promise<AuditCursorPage> {
  const knex = (strapi as any).db.connection;
  const limit = Math.min(Math.max(Number(filters.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = decodeCursor(filters.cursor);
  let query = selectColumns(knex(TABLE));
  query = applyFilters(query, filters);
  if (!filters.includeChildren && !filters.rootEventId) query.whereNull("parent_event_id");
  if (cursor) {
    query.where((builder: any) => {
      builder
        .where("occurred_at", "<", cursor.occurredAt)
        .orWhere((sameTime: any) => sameTime.where("occurred_at", cursor.occurredAt).andWhere("id", "<", cursor.id));
    });
  }
  const rows = await query.orderBy("occurred_at", "desc").orderBy("id", "desc").limit(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(mapAuditRow),
    hasMore,
    nextCursor: hasMore && last
      ? encodeCursor({ occurredAt: new Date(last.occurred_at || last.created_at).toISOString(), id: Number(last.id) })
      : null,
  };
}

export async function findAuditEvent(strapi: Strapi, eventId: string): Promise<AuditEventRecord | null> {
  const knex = (strapi as any).db.connection;
  const row = await selectColumns(knex(TABLE))
    .where(Number.isSafeInteger(Number(eventId)) && Number(eventId) > 0
      ? { id: Number(eventId) }
      : { event_id: eventId })
    .first();
  return row ? mapAuditRow(row) : null;
}

export async function findRelatedAuditEvents(
  strapi: Strapi,
  eventId: string,
  filters: AuditQuery = {},
): Promise<AuditCursorPage> {
  const event = await findAuditEvent(strapi, eventId);
  if (!event) return { items: [], hasMore: false, nextCursor: null };
  return findAuditEvents(strapi, {
    ...filters,
    rootEventId: event.rootEventId || event.eventId,
    includeChildren: true,
  });
}

export async function getAuditSummary(strapi: Strapi, filters: AuditQuery): Promise<AuditSummary> {
  const knex = (strapi as any).db.connection;
  const base = () => applyFilters(knex(TABLE), filters, false);
  const countsQuery = base().select(
    knex.raw("count(*)::int as total"),
    knex.raw("count(*) filter (where actor_type in ('human', 'impersonated_human'))::int as human"),
    knex.raw("count(*) filter (where actor_type not in ('human', 'impersonated_human'))::int as automatic"),
    knex.raw("count(*) filter (where result_status in ('failure', 'denied'))::int as failed_or_denied"),
    knex.raw("count(distinct initiator_id) filter (where initiator_type in ('human', 'impersonated_human'))::int as active_admins"),
  ).first();
  const seriesQuery = base()
    .select(knex.raw("to_char(date_trunc('day', occurred_at at time zone 'Asia/Tehran'), 'YYYY-MM-DD') as date"))
    .select(knex.raw("count(*) filter (where actor_type in ('human', 'impersonated_human'))::int as human"))
    .select(knex.raw("count(*) filter (where actor_type not in ('human', 'impersonated_human'))::int as automatic"))
    .groupByRaw("date_trunc('day', occurred_at at time zone 'Asia/Tehran')")
    .orderByRaw("date_trunc('day', occurred_at at time zone 'Asia/Tehran') asc");
  const [counts, series] = await Promise.all([countsQuery, seriesQuery]);
  return {
    total: Number(counts?.total || 0),
    human: Number(counts?.human || 0),
    automatic: Number(counts?.automatic || 0),
    failedOrDenied: Number(counts?.failed_or_denied || 0),
    activeAdmins: Number(counts?.active_admins || 0),
    series: series.map((row: any) => ({
      date: row.date,
      human: Number(row.human || 0),
      automatic: Number(row.automatic || 0),
    })),
  };
}

export async function getAuditFilterOptions(strapi: Strapi, filters: AuditQuery): Promise<Record<string, unknown>> {
  const knex = (strapi as any).db.connection;
  const base = () => applyFilters(knex(TABLE), { from: filters.from, to: filters.to }, false);
  const [admins, sources, domains, eventKeys, targetTypes] = await Promise.all([
    base().whereIn("initiator_type", ["human", "impersonated_human"]).whereNotNull("initiator_id")
      .distinct("initiator_id as id", "initiator_label as label", "initiator_role_name as role")
      .orderBy("initiator_label", "asc").limit(250),
    base().whereNotNull("origin").distinct("origin as value").orderBy("origin"),
    base().whereNotNull("domain").distinct("domain as value").orderBy("domain"),
    base().whereNotNull("event_key").distinct("event_key as value").orderBy("event_key").limit(500),
    base().whereNotNull("target_type").distinct("target_type as value").orderBy("target_type"),
  ]);
  return { admins, sources, domains, eventKeys, targetTypes };
}

export const __auditQueryInternals = { encodeCursor, decodeCursor, applyFilters };
