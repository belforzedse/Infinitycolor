import type { Strapi } from "@strapi/strapi";
import { factories } from "@strapi/strapi";
import { createHash, randomUUID } from "node:crypto";

import {
  canonicalCustomerPhone,
  normalizeCustomerPhoneDigits,
} from "../../../utils/customerPhoneIdentity";
import { writeAuditEvent } from "../../../audit/writer";
import { resolveUserFullName } from "../../../utils/userDisplayName";
import type { AdminActor } from "../../../utils/adminAuthorization";

const TABLE = "issue_reports";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_EXPORT_ROWS = 10_000;
const ALLOWED_CREATE_KEYS = new Set([
  "submissionId",
  "number",
  "issueName",
  "description",
  "sourcePath",
  "locale",
  "context",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = ["new", "in_review", "resolved"] as const;
const PHONEISH_PATTERN = /^[+\d۰-۹٠-٩\s().-]+$/;

export type IssueReportStatus = (typeof STATUSES)[number];

export class IssueReportError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IssueReportError";
  }
}

export type CreateIssueReportInput = {
  submissionId: string;
  contactNumber: string;
  issueName: string;
  description: string;
  sourcePath: string | null;
  locale: string;
  context: IssueReportClientContext | null;
};

export type IssueReportClientContext = {
  clientTime: string | null;
  timeZone: string | null;
  language: string | null;
  viewport: { width: number; height: number } | null;
  screen: { width: number; height: number; pixelRatio: number } | null;
  online: boolean | null;
  connectionType: string | null;
};

export type IssueReportQuery = {
  cursor?: string;
  limit?: number;
  status?: IssueReportStatus;
  search?: string;
  from?: string;
  to?: string;
};

type Cursor = { createdAt: string; id: number };

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new IssueReportError("ISSUE_REPORT_INVALID", 400, "اطلاعات گزارش کامل نیست.", {
      field,
    });
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new IssueReportError("ISSUE_REPORT_REQUIRED", 400, "این فیلد الزامی است.", {
      field,
    });
  }
  if ([...normalized].length > max) {
    throw new IssueReportError("ISSUE_REPORT_TOO_LONG", 400, "متن واردشده بیش از حد طولانی است.", {
      field,
      max,
    });
  }
  return normalized;
}

function sourcePath(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new IssueReportError("ISSUE_REPORT_SOURCE_INVALID", 400, "صفحه مبدأ نامعتبر است.", {
      field: "sourcePath",
    });
  }
  return value;
}

function optionalShortText(value: unknown, max: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : null;
}

function dimension(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100_000 ? Math.round(parsed) : null;
}

function clientContext(value: unknown): IssueReportClientContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, any>;
  const clientTime = optionalShortText(raw.clientTime, 40);
  const parsedTime = clientTime ? new Date(clientTime) : null;
  const viewportWidth = dimension(raw.viewport?.width);
  const viewportHeight = dimension(raw.viewport?.height);
  const screenWidth = dimension(raw.screen?.width);
  const screenHeight = dimension(raw.screen?.height);
  const pixelRatio = Number(raw.screen?.pixelRatio);
  return {
    clientTime: parsedTime && !Number.isNaN(parsedTime.getTime()) ? parsedTime.toISOString() : null,
    timeZone: optionalShortText(raw.timeZone, 80),
    language: optionalShortText(raw.language, 32),
    viewport:
      viewportWidth != null && viewportHeight != null
        ? { width: viewportWidth, height: viewportHeight }
        : null,
    screen:
      screenWidth != null && screenHeight != null
        ? {
            width: screenWidth,
            height: screenHeight,
            pixelRatio:
              Number.isFinite(pixelRatio) && pixelRatio > 0 && pixelRatio <= 10
                ? Math.round(pixelRatio * 100) / 100
                : 1,
          }
        : null,
    online: typeof raw.online === "boolean" ? raw.online : null,
    connectionType: optionalShortText(raw.connectionType, 24),
  };
}

export function validateCreateIssueReportPayload(body: unknown): CreateIssueReportInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IssueReportError("ISSUE_REPORT_INVALID", 400, "درخواست نامعتبر است.");
  }
  if (utf8Bytes(body) > 32 * 1024) {
    throw new IssueReportError("ISSUE_REPORT_BODY_TOO_LARGE", 413, "حجم گزارش بیش از حد مجاز است.");
  }
  const record = body as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !ALLOWED_CREATE_KEYS.has(key));
  if (unexpected.length > 0) {
    throw new IssueReportError(
      "ISSUE_REPORT_UNEXPECTED_FIELD",
      400,
      "درخواست شامل فیلد ناشناخته است.",
    );
  }
  const submissionId = String(record.submissionId || "").toLowerCase();
  if (!UUID_PATTERN.test(submissionId)) {
    throw new IssueReportError(
      "ISSUE_REPORT_SUBMISSION_ID_INVALID",
      400,
      "شناسه ارسال نامعتبر است.",
    );
  }
  if (typeof record.number !== "string" || record.number.length > 64) {
    throw new IssueReportError("ISSUE_REPORT_PHONE_INVALID", 400, "شماره تماس معتبر نیست.", {
      field: "number",
    });
  }
  const contactNumber = canonicalCustomerPhone(record.number);
  if (!contactNumber) {
    throw new IssueReportError("ISSUE_REPORT_PHONE_INVALID", 400, "شماره تماس معتبر نیست.", {
      field: "number",
    });
  }
  const locale =
    typeof record.locale === "string" && record.locale.trim()
      ? record.locale.trim().slice(0, 16)
      : "fa-IR";
  return {
    submissionId,
    contactNumber,
    issueName: text(record.issueName, "issueName", 120),
    description: text(record.description, "description", 4_000),
    sourcePath: sourcePath(record.sourcePath),
    locale,
    context: clientContext(record.context),
  };
}

function payloadHash(input: CreateIssueReportInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contactNumber: input.contactNumber,
        issueName: input.issueName,
        description: input.description,
        sourcePath: input.sourcePath,
        locale: input.locale,
        context: input.context,
      }),
    )
    .digest("hex");
}

function dbTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.ISSUE_REPORT_DB_TIMEOUT_MS || "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 500 && parsed <= 15_000 ? parsed : 3_000;
}

function maxInFlight(): number {
  const parsed = Number.parseInt(process.env.ISSUE_REPORT_MAX_IN_FLIGHT || "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 3;
}

let activeWrites = 0;

function observeMetric(strapi: Strapi, name: string, value: number) {
  const metrics = (strapi as any).metrics;
  if (typeof metrics?.observe === "function") metrics.observe(name, value);
  else metrics?.histogram?.(name)?.observe?.(value);
}

function mapSummary(row: any) {
  return {
    reportId: row.public_id,
    issueName: row.issue_name,
    contactNumber: row.contact_number,
    descriptionPreview: row.description_preview ?? null,
    status: row.status as IssueReportStatus,
    submittedAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    sourcePath: row.source_path ?? null,
    reporterUserId: row.reporter_user_id == null ? null : Number(row.reporter_user_id),
    version: Number(row.version),
  };
}

function mapClientContext(value: unknown): IssueReportClientContext | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as IssueReportClientContext;
  }
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as IssueReportClientContext)
      : null;
  } catch {
    return null;
  }
}

function mapDetail(row: any) {
  return {
    ...mapSummary(row),
    description: row.description,
    clientContext: mapClientContext(row.client_context),
    userAgent: row.user_agent ?? null,
  };
}

export async function createIssueReport(
  strapi: Strapi,
  input: CreateIssueReportInput,
  metadata: {
    reporterUserId?: number | null;
    requestId?: string | null;
    userAgent?: string | null;
  },
) {
  if (activeWrites >= maxInFlight()) {
    throw new IssueReportError(
      "ISSUE_REPORT_BUSY",
      503,
      "سامانه موقتاً شلوغ است. چند لحظه دیگر دوباره تلاش کنید.",
      { retryAfterSeconds: 5 },
    );
  }
  activeWrites += 1;
  const startedAt = Date.now();
  try {
    const knex = strapi.db.connection as any;
    const hash = payloadHash(input);
    const now = new Date();
    return await knex.transaction(async (trx: any) => {
      await trx.raw("SELECT set_config('statement_timeout', ?, true)", [String(dbTimeoutMs())]);
      const inserted = await trx(TABLE)
        .insert({
          public_id: randomUUID(),
          contact_number: input.contactNumber,
          issue_name: input.issueName,
          description: input.description,
          reporter_user_id: metadata.reporterUserId || null,
          source_path: input.sourcePath,
          locale: input.locale,
          client_context: input.context,
          user_agent: metadata.userAgent?.slice(0, 512) || null,
          request_id: metadata.requestId?.slice(0, 64) || null,
          submission_id: input.submissionId,
          payload_hash: hash,
          status: "new",
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict("submission_id")
        .ignore()
        .returning(["public_id", "created_at"]);
      if (inserted[0]) {
        return {
          reportId: inserted[0].public_id,
          createdAt: new Date(inserted[0].created_at).toISOString(),
          replayed: false,
        };
      }
      const existing = await trx(TABLE)
        .where({ submission_id: input.submissionId })
        .first("public_id", "created_at", "payload_hash");
      if (!existing) throw new Error("ISSUE_REPORT_IDEMPOTENCY_LOOKUP_FAILED");
      if (existing.payload_hash !== hash) {
        throw new IssueReportError(
          "ISSUE_REPORT_SUBMISSION_ID_REUSED",
          409,
          "این ارسال با اطلاعات دیگری ثبت شده است. دوباره ارسال کنید.",
        );
      }
      return {
        reportId: existing.public_id,
        createdAt: new Date(existing.created_at).toISOString(),
        replayed: true,
      };
    });
  } finally {
    observeMetric(strapi, "issue_reports_db_write_duration_ms", Date.now() - startedAt);
    activeWrites -= 1;
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value?: string): Cursor | null {
  if (!value) return null;
  if (value.length > 512)
    throw new IssueReportError("ISSUE_REPORT_CURSOR_INVALID", 400, "نشانگر صفحه نامعتبر است.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const createdAt = new Date(parsed?.createdAt);
    const id = Number(parsed?.id);
    if (Number.isNaN(createdAt.getTime()) || !Number.isSafeInteger(id) || id <= 0)
      throw new Error();
    return { createdAt: createdAt.toISOString(), id };
  } catch {
    throw new IssueReportError("ISSUE_REPORT_CURSOR_INVALID", 400, "نشانگر صفحه نامعتبر است.");
  }
}

function queryDate(value: unknown, field: string): Date | null {
  if (!value) return null;
  if (typeof value !== "string")
    throw new IssueReportError("ISSUE_REPORT_FILTER_INVALID", 400, "فیلتر تاریخ نامعتبر است.", {
      field,
    });
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new IssueReportError("ISSUE_REPORT_FILTER_INVALID", 400, "فیلتر تاریخ نامعتبر است.", {
      field,
    });
  return date;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function phonePrefix(value: string): string | null {
  const normalized = normalizeCustomerPhoneDigits(value);
  let digits = normalized.replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = digits.slice(4);
  else if (digits.startsWith("98")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (!digits.startsWith("9") || digits.length > 10) return null;
  return `+98${digits}`;
}

function applyFilters(query: any, filters: IssueReportQuery): any {
  if (filters.status) {
    if (!STATUSES.includes(filters.status))
      throw new IssueReportError("ISSUE_REPORT_FILTER_INVALID", 400, "وضعیت نامعتبر است.");
    query.where("status", filters.status);
  }
  const from = queryDate(filters.from, "from");
  const to = queryDate(filters.to, "to");
  if (from) query.where("created_at", ">=", from);
  if (to) query.where("created_at", "<=", to);
  if (from && to && from > to)
    throw new IssueReportError("ISSUE_REPORT_FILTER_INVALID", 400, "بازه تاریخ نامعتبر است.");

  const search = typeof filters.search === "string" ? filters.search.trim() : "";
  if (search.length > 120)
    throw new IssueReportError(
      "ISSUE_REPORT_SEARCH_TOO_LONG",
      400,
      "عبارت جست‌وجو بیش از حد طولانی است.",
    );
  if (search) {
    if (UUID_PATTERN.test(search)) query.where("public_id", search.toLowerCase());
    else if (PHONEISH_PATTERN.test(search)) {
      const prefix = phonePrefix(search);
      if (!prefix)
        throw new IssueReportError(
          "ISSUE_REPORT_SEARCH_INVALID",
          400,
          "شماره جست‌وجو نامعتبر است.",
        );
      query.where("contact_number", "like", `${escapeLike(prefix)}%`);
    } else {
      query.whereILike("issue_name", `%${escapeLike(search)}%`);
    }
  }
  return query;
}

function baseSelect(knex: any) {
  return knex(TABLE).select([
    "id",
    "public_id",
    "contact_number",
    "issue_name",
    "status",
    "source_path",
    "reporter_user_id",
    "version",
    "created_at",
    "updated_at",
    knex.raw("substring(description from 1 for 160) as description_preview"),
  ]);
}

export async function queryIssueReports(strapi: Strapi, filters: IssueReportQuery) {
  const knex = strapi.db.connection as any;
  const limit = Math.min(Math.max(Number(filters.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = decodeCursor(filters.cursor);
  let query = applyFilters(baseSelect(knex), filters);
  if (cursor) {
    query.where((builder: any) => {
      builder
        .where("created_at", "<", cursor.createdAt)
        .orWhere((same: any) =>
          same.where("created_at", cursor.createdAt).andWhere("id", "<", cursor.id),
        );
    });
  }
  const rows = await query
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(mapSummary),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: new Date(last.created_at).toISOString(), id: Number(last.id) })
        : null,
  };
}

export async function findIssueReport(strapi: Strapi, reportId: string) {
  if (!UUID_PATTERN.test(reportId))
    throw new IssueReportError("ISSUE_REPORT_ID_INVALID", 400, "شناسه گزارش نامعتبر است.");
  const row = await (strapi.db.connection as any)(TABLE)
    .where({ public_id: reportId.toLowerCase() })
    .first([
      "public_id",
      "contact_number",
      "issue_name",
      "description",
      "status",
      "source_path",
      "reporter_user_id",
      "client_context",
      "user_agent",
      "version",
      "created_at",
      "updated_at",
    ]);
  return row ? mapDetail(row) : null;
}

export async function updateIssueReportStatus(
  strapi: Strapi,
  reportId: string,
  status: IssueReportStatus,
  expectedVersion: number,
  actor: AdminActor,
) {
  if (!UUID_PATTERN.test(reportId))
    throw new IssueReportError("ISSUE_REPORT_ID_INVALID", 400, "شناسه گزارش نامعتبر است.");
  if (!STATUSES.includes(status))
    throw new IssueReportError("ISSUE_REPORT_STATUS_INVALID", 400, "وضعیت نامعتبر است.");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new IssueReportError("ISSUE_REPORT_VERSION_INVALID", 400, "نسخه گزارش نامعتبر است.");
  const knex = strapi.db.connection as any;
  return knex.transaction(async (trx: any) => {
    const current = await trx(TABLE)
      .where({ public_id: reportId.toLowerCase() })
      .first("status", "version");
    if (!current) return { kind: "not-found" as const };
    if (Number(current.version) !== expectedVersion) {
      return {
        kind: "conflict" as const,
        current: { status: current.status, version: Number(current.version) },
      };
    }
    if (current.status === status) {
      const row = await trx(TABLE)
        .where({ public_id: reportId.toLowerCase() })
        .first([
          "public_id",
          "contact_number",
          "issue_name",
          "description",
          "status",
          "source_path",
          "reporter_user_id",
          "client_context",
          "user_agent",
          "version",
          "created_at",
          "updated_at",
        ]);
      return { kind: "success" as const, data: mapDetail(row) };
    }
    const rows = await trx(TABLE)
      .where({ public_id: reportId.toLowerCase(), version: expectedVersion })
      .update({ status, version: expectedVersion + 1, updated_at: new Date() })
      .returning([
        "public_id",
        "contact_number",
        "issue_name",
        "description",
        "status",
        "source_path",
        "reporter_user_id",
        "client_context",
        "user_agent",
        "version",
        "created_at",
        "updated_at",
      ]);
    if (!rows[0]) {
      const latest = await trx(TABLE)
        .where({ public_id: reportId.toLowerCase() })
        .first("status", "version");
      return {
        kind: "conflict" as const,
        current: { status: latest.status, version: Number(latest.version) },
      };
    }
    const actorName =
      resolveUserFullName(actor.user) ||
      actor.user.email ||
      actor.user.username ||
      `User ${actor.user.id}`;
    await writeAuditEvent(
      strapi,
      {
        eventKey: "issue_reports.status_changed",
        initiator: { type: "human", id: actor.user.id, label: actorName, role: actor.role },
        actor: { type: "human", id: actor.user.id, label: actorName, role: actor.role },
        origin: "admin_ui",
        target: { type: "issue_report", id: reportId },
        changes: [{ field: "status", from: current.status, to: status }],
        dedupeKey: `issue-report-status:${reportId}:${expectedVersion}:${status}`,
      },
      { trx },
    );
    return { kind: "success" as const, data: mapDetail(rows[0]) };
  });
}

export async function exportIssueReports(strapi: Strapi, filters: IssueReportQuery) {
  const knex = strapi.db.connection as any;
  let query = applyFilters(
    knex(TABLE).select([
      "public_id",
      "contact_number",
      "issue_name",
      "description",
      "status",
      "source_path",
      "reporter_user_id",
      "client_context",
      "user_agent",
      "version",
      "created_at",
      "updated_at",
    ]),
    filters,
  );
  const rows = await query
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(MAX_EXPORT_ROWS + 1);
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new IssueReportError(
      "ISSUE_REPORT_EXPORT_TOO_LARGE",
      422,
      "تعداد نتایج زیاد است. فیلترها یا بازه تاریخ را محدود کنید.",
      { maxRows: MAX_EXPORT_ROWS },
    );
  }
  return rows.map(mapDetail);
}

export const __issueReportInternals = {
  TABLE,
  MAX_EXPORT_ROWS,
  STATUSES,
  encodeCursor,
  decodeCursor,
  phonePrefix,
  applyFilters,
  payloadHash,
  maxInFlight,
};

export default factories.createCoreService("api::issue-report.issue-report" as any);
