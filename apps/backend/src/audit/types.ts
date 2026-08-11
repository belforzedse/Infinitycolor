export const AUDIT_SCHEMA_VERSION = 2 as const;

export const AUDIT_ACTOR_TYPES = [
  "human",
  "impersonated_human",
  "service_account",
  "integration",
  "scheduled_job",
  "background_worker",
  "webhook",
  "migration",
  "system",
  "unknown",
] as const;

export const AUDIT_INITIATOR_TYPES = [
  ...AUDIT_ACTOR_TYPES,
  "customer",
] as const;

export const AUDIT_ORIGINS = [
  "admin_ui",
  "storefront",
  "public_api",
  "internal_api",
  "scheduled_task",
  "queue",
  "webhook",
  "import",
  "migration",
  "maintenance",
  "legacy",
] as const;

export const AUDIT_RESULTS = [
  "success",
  "partial",
  "failure",
  "denied",
  "queued",
  "cancelled",
  "no_op",
] as const;
export const AUDIT_IMPORTANCE = ["normal", "important", "sensitive", "critical"] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export type AuditInitiatorType = (typeof AUDIT_INITIATOR_TYPES)[number];
export type AuditOrigin = (typeof AUDIT_ORIGINS)[number];
export type AuditResult = (typeof AUDIT_RESULTS)[number];
export type AuditImportance = (typeof AUDIT_IMPORTANCE)[number];
export type AuditMode = "human" | "automatic" | "all";

export interface AuditPrincipal<
  T extends AuditActorType | AuditInitiatorType = AuditActorType | AuditInitiatorType,
> {
  type: T;
  id?: string | number | null;
  label?: string | null;
  role?: string | null;
  roleId?: string | number | null;
  authMethod?: string | null;
}

export interface AuditEntityRef {
  type: string;
  id?: string | number | null;
  label?: string | null;
  snapshot?: Record<string, unknown> | null;
}

export interface AuditFieldChange {
  field: string;
  from?: unknown;
  to?: unknown;
  label?: string;
}

export interface AuditRequestOrigin {
  ip?: string | null;
  userAgent?: string | null;
  route?: string | null;
  method?: string | null;
}

export interface AuditContext {
  initiator: AuditPrincipal<AuditInitiatorType>;
  actor: AuditPrincipal<AuditActorType>;
  origin: AuditOrigin;
  requestId?: string | null;
  interactionId?: string | null;
  correlationId?: string | null;
  rootEventId?: string | null;
  parentEventId?: string | null;
  jobId?: string | null;
  batchId?: string | null;
  requestOrigin?: AuditRequestOrigin | null;
  causationId?: string | null;
  traceId?: string | null;
  environment?: string | null;
  service?: string | null;
  scope?: Record<string, unknown> | null;
}

export interface AuditJobContext {
  schemaVersion: 1;
  initiator: AuditPrincipal<AuditInitiatorType>;
  origin: AuditOrigin;
  requestId?: string;
  interactionId?: string;
  correlationId?: string;
  rootEventId?: string;
  parentEventId?: string;
  batchId?: string;
  causationId?: string;
  traceId?: string;
}

export interface AuditEventInput {
  eventKey: string;
  domain?: string;
  operation?: string;
  importance?: AuditImportance;
  result?: AuditResult;
  initiator?: AuditPrincipal<AuditInitiatorType>;
  actor?: AuditPrincipal<AuditActorType>;
  origin?: AuditOrigin;
  target?: AuditEntityRef | null;
  related?: AuditEntityRef | null;
  changes?: AuditFieldChange[] | Record<string, { from?: unknown; to?: unknown }> | null;
  metadata?: Record<string, unknown> | null;
  reasonCode?: string | null;
  summaryFa?: string | null;
  summaryEn?: string | null;
  description?: string | null;
  occurredAt?: Date | string;
  eventId?: string;
  rootEventId?: string | null;
  parentEventId?: string | null;
  requestId?: string | null;
  interactionId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  traceId?: string | null;
  jobId?: string | number | null;
  batchId?: string | number | null;
  route?: string | null;
  httpMethod?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  dedupeKey?: string | null;
  environment?: string | null;
  service?: string | null;
  scope?: Record<string, unknown> | null;
}

export interface AuditEventRecord {
  id: number;
  eventId: string;
  schemaVersion: number;
  occurredAt: string;
  recordedAt: string;
  eventKey: string;
  domain: string;
  operation: string;
  importance: AuditImportance;
  result: AuditResult;
  mode: Exclude<AuditMode, "all">;
  initiator: AuditPrincipal;
  actor: AuditPrincipal;
  origin: AuditOrigin;
  target: AuditEntityRef | null;
  related: AuditEntityRef | null;
  changes: AuditFieldChange[];
  metadata?: Record<string, unknown> | null;
  summaryFa: string;
  summaryEn?: string | null;
  reasonCode?: string | null;
  rootEventId?: string | null;
  parentEventId?: string | null;
  requestId?: string | null;
  interactionId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  traceId?: string | null;
  jobId?: string | null;
  batchId?: string | null;
  route?: string | null;
  httpMethod?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  environment?: string | null;
  service?: string | null;
  scope?: Record<string, unknown> | null;
  legacy?: boolean;
}

export interface AuditQuery {
  from?: string;
  to?: string;
  mode?: AuditMode;
  initiatorId?: string;
  actorType?: AuditActorType;
  role?: string;
  origin?: AuditOrigin;
  domain?: string;
  eventKey?: string;
  targetType?: string;
  targetId?: string;
  result?: AuditResult;
  importance?: AuditImportance;
  search?: string;
  correlationId?: string;
  rootEventId?: string;
  cursor?: string;
  limit?: number;
  includeChildren?: boolean;
}

export interface AuditCursorPage<T = AuditEventRecord> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AuditSummary {
  total: number;
  human: number;
  automatic: number;
  failedOrDenied: number;
  activeAdmins: number;
  series: Array<{ date: string; human: number; automatic: number }>;
}

export const isHumanActor = (type: AuditActorType | string | null | undefined): boolean =>
  type === "human" || type === "impersonated_human";
