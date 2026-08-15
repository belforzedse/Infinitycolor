import { randomUUID } from "node:crypto";
import type { Strapi } from "@strapi/strapi";

import { getAuditContext } from "../utils/audit-context";
import { resolveRawExecutor } from "../utils/transactionExecutor";
import { resolveUserFullName } from "../utils/userDisplayName";
import { resolveAuditDefinition } from "./catalog";
import {
  normalizeAuditChanges,
  sanitizeAuditValue,
  sanitizeRequestIp,
  sanitizeUserAgent,
} from "./sanitizer";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_IMPORTANCE,
  AUDIT_INITIATOR_TYPES,
  AUDIT_RESULTS,
  AUDIT_SCHEMA_VERSION,
  AUDIT_ORIGINS,
  type AuditContext,
  type AuditEventInput,
  type AuditActorType,
  type AuditInitiatorType,
  type AuditPrincipal,
} from "./types";

const TABLE = "manual_admin_activities";
const EVENT_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AuditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditValidationError";
  }
}

function canonicalId(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value).slice(0, 160);
}

function assertPrincipal(
  principal: AuditPrincipal,
  allowed: readonly string[],
  name: string,
): void {
  if (!allowed.includes(principal.type)) {
    throw new AuditValidationError(`Invalid ${name} type: ${principal.type}`);
  }
  if (["human", "impersonated_human"].includes(principal.type) && principal.id == null) {
    throw new AuditValidationError(`${name} human principal requires an id`);
  }
}

export function resolveCurrentAuditContext(): AuditContext | null {
  const request = getAuditContext();
  const koa = (global as any)?.strapi?.requestContext?.get?.();
  if (!request && !koa) return null;
  if (request.canonical) return request.canonical;
  const liveUser = koa?.state?.adminActor?.user || koa?.state?.user;
  const liveRole = koa?.state?.adminActor?.role || liveUser?.role?.name || liveUser?.role?.type || null;
  const liveId = liveUser?.id ?? request?.userId ?? null;
  const liveLabel =
    request?.resolvedName ||
    resolveUserFullName(liveUser) ||
    request?.userLabel ||
    liveUser?.email ||
    liveUser?.username ||
    null;
  const isAdmin = Boolean(koa?.state?.adminActor || request?.isAdmin);
  const initiator: AuditPrincipal<AuditInitiatorType> = liveId
    ? {
        type: "human",
        id: liveId,
        label: liveLabel,
        role: request?.roleName || liveRole,
      }
    : { type: "unknown" };
  const actor: AuditPrincipal<AuditActorType> = liveId
    ? { type: "human", id: liveId, label: liveLabel, role: isAdmin ? liveRole : null }
    : { type: "service_account", id: "backend", label: "Infinity Backend" };
  return {
    initiator,
    actor,
    origin: isAdmin ? "admin_ui" : "public_api",
    requestId: request?.requestId || null,
    interactionId: request?.interactionId || null,
    correlationId: request?.correlationId || request?.requestId || null,
    requestOrigin: {
      ip: request?.ip || null,
      userAgent: request?.userAgent || null,
      route: request?.route || koa?.path || null,
      method: request?.method || koa?.method || null,
    },
  };
}

function resolveEventContext(input: AuditEventInput): AuditContext {
  const ambient = resolveCurrentAuditContext();
  const initiator = input.initiator || ambient?.initiator || { type: "unknown" as const };
  const actor = input.actor || ambient?.actor;
  if (!actor) {
    throw new AuditValidationError("Audit actor is required outside an audited request context");
  }
  const origin = input.origin || ambient?.origin;
  if (!origin) throw new AuditValidationError("Audit origin is required");
  assertPrincipal(initiator, AUDIT_INITIATOR_TYPES, "initiator");
  assertPrincipal(actor, AUDIT_ACTOR_TYPES, "actor");
  if (!AUDIT_ORIGINS.includes(origin)) throw new AuditValidationError(`Invalid origin: ${origin}`);
  return {
    initiator,
    actor,
    origin,
    requestId: input.requestId ?? ambient?.requestId ?? null,
    interactionId: input.interactionId ?? ambient?.interactionId ?? null,
    correlationId: input.correlationId ?? ambient?.correlationId ?? null,
    causationId: input.causationId ?? ambient?.causationId ?? null,
    traceId: input.traceId ?? ambient?.traceId ?? null,
    rootEventId: input.rootEventId ?? ambient?.rootEventId ?? null,
    parentEventId: input.parentEventId ?? ambient?.parentEventId ?? null,
    jobId: canonicalId(input.jobId ?? ambient?.jobId),
    batchId: canonicalId(input.batchId ?? ambient?.batchId),
    requestOrigin: {
      ip: input.ip ?? ambient?.requestOrigin?.ip ?? null,
      userAgent: input.userAgent ?? ambient?.requestOrigin?.userAgent ?? null,
      route: input.route ?? ambient?.requestOrigin?.route ?? null,
      method: input.httpMethod ?? ambient?.requestOrigin?.method ?? null,
    },
    environment: input.environment ?? ambient?.environment ?? process.env.NODE_ENV ?? "development",
    service: input.service ?? ambient?.service ?? "infinity-backend",
  };
}

function legacyAction(operation: string): string {
  const map: Record<string, string> = {
    create: "Create", update: "Update", delete: "Delete", publish: "Publish",
    unpublish: "Unpublish", adjust: "Adjust", import: "Import", refund: "Refund",
    status_change: "StatusChange",
  };
  return map[operation] || "Other";
}

function legacyResource(targetType?: string | null): string {
  const value = (targetType || "other").toLowerCase();
  if (value === "order") return "Order";
  if (value === "product") return "Product";
  if (["user", "customer", "admin"].includes(value)) return "User";
  if (value === "discount") return "Discount";
  if (value === "stock" || value === "inventory") return "Stock";
  if (value === "contract") return "Contract";
  return "Other";
}

function createSearchText(parts: unknown[]): string {
  return parts
    .filter((value) => value != null && value !== "")
    .map((value) => String(value))
    .join(" ")
    .slice(0, 12_000);
}

function serializeJsonColumn(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

export interface WriteAuditOptions {
  trx?: any;
}

/**
 * Required append-only audit write. Persistence errors propagate to the caller so a surrounding
 * business transaction cannot commit a sensitive mutation without its corresponding event.
 */
export async function writeAuditEvent(
  strapi: Strapi,
  input: AuditEventInput,
  options: WriteAuditOptions = {},
): Promise<{ id: number | null; eventId: string; deduplicated: boolean }> {
  if (!EVENT_KEY_PATTERN.test(input.eventKey)) {
    throw new AuditValidationError(`Invalid stable event key: ${input.eventKey}`);
  }
  const context = resolveEventContext(input);
  const definition = resolveAuditDefinition(input.eventKey);
  const result = input.result || "success";
  const importance = input.importance || definition.importance;
  if (!AUDIT_RESULTS.includes(result)) throw new AuditValidationError(`Invalid result: ${result}`);
  if (!AUDIT_IMPORTANCE.includes(importance)) {
    throw new AuditValidationError(`Invalid importance: ${importance}`);
  }

  const eventId = input.eventId || randomUUID();
  if (!UUID_PATTERN.test(eventId)) throw new AuditValidationError("eventId must be a UUID");
  const rootEventId = input.rootEventId || context.rootEventId || eventId;
  if (!UUID_PATTERN.test(rootEventId)) throw new AuditValidationError("rootEventId must be a UUID");
  if (context.parentEventId && !UUID_PATTERN.test(context.parentEventId)) {
    throw new AuditValidationError("parentEventId must be a UUID");
  }
  if (context.interactionId && !UUID_PATTERN.test(context.interactionId)) {
    throw new AuditValidationError("interactionId must be a UUID");
  }

  const changes = normalizeAuditChanges(input.changes);
  const metadata = input.metadata ? sanitizeAuditValue(input.metadata) : null;
  const targetSnapshot = input.target?.snapshot ? sanitizeAuditValue(input.target.snapshot) : null;
  const relatedSnapshot = input.related?.snapshot ? sanitizeAuditValue(input.related.snapshot) : null;
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new AuditValidationError("occurredAt is invalid");
  const summaryFa = input.summaryFa || definition.titleFa;
  const summaryEn = input.summaryEn || definition.titleEn;
  const hasHumanOrigin =
    ["human", "impersonated_human"].includes(context.actor.type) ||
    input.eventKey.startsWith("authentication.") ||
    input.eventKey === "security.access_denied";
  const row = {
    event_id: eventId,
    schema_version: AUDIT_SCHEMA_VERSION,
    occurred_at: occurredAt,
    recorded_at: new Date(),
    event_key: input.eventKey,
    domain: input.domain || definition.domain,
    operation: input.operation || definition.operation,
    importance,
    result_status: result,
    initiator_type: context.initiator.type,
    initiator_id: canonicalId(context.initiator.id),
    initiator_label: context.initiator.label?.slice(0, 255) || null,
    initiator_role_id: canonicalId(context.initiator.roleId),
    initiator_role_name: context.initiator.role?.slice(0, 120) || null,
    actor_type: context.actor.type,
    actor_id: canonicalId(context.actor.id),
    actor_label: context.actor.label?.slice(0, 255) || null,
    actor_role_id: canonicalId(context.actor.roleId),
    actor_role_name: context.actor.role?.slice(0, 120) || null,
    actor_auth_method: context.actor.authMethod?.slice(0, 80) || null,
    origin: context.origin,
    target_type: input.target?.type?.slice(0, 80) || null,
    target_id: canonicalId(input.target?.id),
    target_label: input.target?.label?.slice(0, 255) || null,
    target_snapshot: targetSnapshot,
    related_type: input.related?.type?.slice(0, 80) || null,
    related_id: canonicalId(input.related?.id),
    related_label: input.related?.label?.slice(0, 255) || null,
    related_snapshot: relatedSnapshot,
    root_event_id: rootEventId,
    parent_event_id: context.parentEventId || null,
    request_id: canonicalId(context.requestId),
    interaction_id: context.interactionId || null,
    correlation_id: canonicalId(context.correlationId),
    causation_id: canonicalId(context.causationId),
    trace_id: canonicalId(context.traceId),
    job_id: canonicalId(context.jobId),
    batch_id: canonicalId(context.batchId),
    route: context.requestOrigin?.route?.slice(0, 255) || null,
    http_method: context.requestOrigin?.method?.slice(0, 16).toUpperCase() || null,
    reason_code: input.reasonCode?.slice(0, 120) || null,
    environment: context.environment?.slice(0, 80) || null,
    service_name: context.service?.slice(0, 120) || null,
    scope: input.scope ? sanitizeAuditValue(input.scope) : null,
    dedupe_key: input.dedupeKey?.slice(0, 255) || null,
    resource_type: legacyResource(input.target?.type),
    resource_id: canonicalId(input.target?.id),
    action: legacyAction(input.operation || definition.operation),
    title: summaryFa,
    message: summaryFa,
    message_en: summaryEn,
    severity: result === "failure" ? "error" : result === "denied" || result === "partial" ? "warning" : "success",
    changes,
    description: input.description ? sanitizeAuditValue(input.description) : null,
    metadata,
    performed_by_name: context.actor.type === "human" ? context.actor.label || null : null,
    performed_by_role: context.actor.type === "human" ? context.actor.role || null : null,
    ip: hasHumanOrigin ? sanitizeRequestIp(context.requestOrigin?.ip) : null,
    user_agent: hasHumanOrigin ? sanitizeUserAgent(context.requestOrigin?.userAgent) : null,
    search_text: createSearchText([
      input.eventKey, summaryFa, summaryEn, context.initiator.label, context.initiator.id,
      context.actor.label, input.target?.type, input.target?.id, input.target?.label,
      input.related?.type, input.related?.id, input.related?.label, context.correlationId,
      context.jobId, context.batchId,
    ]),
    created_at: new Date(),
    updated_at: new Date(),
  };

  const connection = (strapi as any)?.db?.connection;
  if (!connection) {
    const created = await strapi.entityService.create(
      "api::manual-admin-activity.manual-admin-activity" as any,
      { data: {
        ResourceType: row.resource_type, ResourceId: row.resource_id, Action: row.action,
        Title: row.title, Message: row.message, MessageEn: row.message_en, Severity: row.severity,
        Changes: row.changes, Description: row.description, Metadata: row.metadata,
        performed_by: context.actor.type === "human" ? Number(context.actor.id) : undefined,
        PerformedByName: row.performed_by_name, PerformedByRole: row.performed_by_role,
        IP: row.ip, UserAgent: row.user_agent, eventId: row.event_id, schemaVersion: row.schema_version,
        occurredAt: row.occurred_at, recordedAt: row.recorded_at, eventKey: row.event_key,
        domain: row.domain, operation: row.operation, importance: row.importance,
        resultStatus: row.result_status, initiatorType: row.initiator_type,
        initiatorId: row.initiator_id, initiatorLabel: row.initiator_label,
        initiatorRoleId: row.initiator_role_id, initiatorRoleName: row.initiator_role_name,
        actorType: row.actor_type, actorId: row.actor_id, actorLabel: row.actor_label,
        actorRoleId: row.actor_role_id, actorRoleName: row.actor_role_name,
        actorAuthMethod: row.actor_auth_method, origin: row.origin,
        targetType: row.target_type, targetId: row.target_id,
        targetLabel: row.target_label, targetSnapshot: row.target_snapshot,
        relatedType: row.related_type, relatedId: row.related_id, relatedLabel: row.related_label,
        relatedSnapshot: row.related_snapshot, rootEventId: row.root_event_id,
        parentEventId: row.parent_event_id, requestId: row.request_id,
        interactionId: row.interaction_id, correlationId: row.correlation_id,
        causationId: row.causation_id, traceId: row.trace_id,
        jobId: row.job_id, batchId: row.batch_id, route: row.route, httpMethod: row.http_method,
        reasonCode: row.reason_code, environment: row.environment, serviceName: row.service_name,
        scope: row.scope, searchText: row.search_text, dedupeKey: row.dedupe_key,
      } as any },
    ) as any;
    return { id: created?.id ?? null, eventId, deduplicated: false };
  }

  const executor = await resolveRawExecutor(strapi, options.trx);
  // `pg` treats a top-level JavaScript array as a PostgreSQL array parameter.
  // These columns are JSON/JSONB, so serialize them explicitly for raw Knex
  // inserts. The entityService fallback above intentionally keeps native values.
  const rawRow = {
    ...row,
    target_snapshot: serializeJsonColumn(row.target_snapshot),
    related_snapshot: serializeJsonColumn(row.related_snapshot),
    changes: serializeJsonColumn(row.changes),
    metadata: serializeJsonColumn(row.metadata),
    scope: serializeJsonColumn(row.scope),
  };
  const insert = executor(TABLE).insert(rawRow).returning(["id", "event_id"]);
  const rows = row.dedupe_key
    ? await insert.onConflict("dedupe_key").ignore()
    : await insert;
  const inserted = Array.isArray(rows) ? rows[0] : rows;
  if (inserted) return { id: Number(inserted.id), eventId: inserted.event_id, deduplicated: false };
  const existing = await executor(TABLE).where({ dedupe_key: row.dedupe_key }).first("id", "event_id");
  if (!existing) throw new Error(`Audit deduplication conflict could not resolve ${row.dedupe_key}`);
  return { id: Number(existing.id), eventId: existing.event_id, deduplicated: true };
}
