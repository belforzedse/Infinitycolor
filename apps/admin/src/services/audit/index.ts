import { apiClient } from "@/services";
import { API_BASE_URL } from "@/constants/api";
import { getAccessToken } from "@/utils/auth";

export type AuditActorType =
  | "human"
  | "customer"
  | "impersonated_human"
  | "service_account"
  | "integration"
  | "scheduled_job"
  | "background_worker"
  | "webhook"
  | "migration"
  | "system"
  | "unknown";
export type AuditOrigin =
  | "admin_ui"
  | "storefront"
  | "public_api"
  | "internal_api"
  | "scheduled_task"
  | "queue"
  | "webhook"
  | "import"
  | "migration"
  | "maintenance"
  | "legacy";
export type AuditResult =
  | "success"
  | "partial"
  | "failure"
  | "denied"
  | "queued"
  | "cancelled"
  | "no_op";
export type AuditImportance = "normal" | "important" | "sensitive" | "critical";
export type AuditMode = "human" | "automatic" | "all";

export interface AuditPrincipal {
  type: AuditActorType;
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
  label?: string;
  from?: unknown;
  to?: unknown;
}

export interface AuditEvent {
  id: number;
  eventId: string;
  schemaVersion: number;
  eventKey: string;
  domain: string;
  operation: string;
  importance: AuditImportance;
  result: AuditResult;
  mode: Exclude<AuditMode, "all">;
  occurredAt: string;
  recordedAt: string;
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

export interface AuditPage {
  items: AuditEvent[];
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

export interface AuditFilterOptions {
  admins: Array<{ id: string; label?: string | null; role?: string | null }>;
  sources: Array<{ value: AuditOrigin }>;
  domains: Array<{ value: string }>;
  eventKeys: Array<{ value: string }>;
  targetTypes: Array<{ value: string }>;
}

function queryString(query: AuditQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}

export async function getAuditEvents(query: AuditQuery, signal?: AbortSignal): Promise<AuditPage> {
  return await apiClient.get<AuditEvent[]>(`/audit/events${queryString(query)}`, {
    cache: "no-store",
    signal,
  }) as unknown as AuditPage;
}

export async function getAuditEvent(eventId: string, signal?: AbortSignal): Promise<AuditEvent> {
  const response = await apiClient.get<AuditEvent>(`/audit/events/${encodeURIComponent(eventId)}`, {
    cache: "no-store",
    signal,
  });
  return response.data;
}

export async function getRelatedAuditEvents(
  eventId: string,
  query: AuditQuery = {},
  signal?: AbortSignal,
): Promise<AuditPage> {
  return await apiClient.get<AuditEvent[]>(
    `/audit/events/${encodeURIComponent(eventId)}/related${queryString(query)}`,
    { cache: "no-store", signal },
  ) as unknown as AuditPage;
}

export async function getAuditSummary(query: AuditQuery, signal?: AbortSignal): Promise<AuditSummary> {
  const response = await apiClient.get<AuditSummary>(`/audit/summary${queryString(query)}`, {
    cache: "no-store",
    signal,
  });
  return response.data;
}

export async function getAuditFilterOptions(
  query: Pick<AuditQuery, "from" | "to">,
  signal?: AbortSignal,
): Promise<AuditFilterOptions> {
  const response = await apiClient.get<AuditFilterOptions>(
    `/audit/filter-options${queryString(query)}`,
    { cache: "no-store", signal },
  );
  return response.data;
}

export async function downloadAuditExport(filters: AuditQuery): Promise<void> {
  if (typeof window === "undefined") return;
  const token = await getAccessToken();
  const response = await fetch(`${API_BASE_URL}/audit/exports`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ filters }),
  });
  if (!response.ok) throw new Error(`Audit export failed (${response.status})`);
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `audit-events-${Date.now()}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
