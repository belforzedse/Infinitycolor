import * as Sentry from "@sentry/node";

import { buildStyledWorkbook } from "../../../utils/styledWorkbook";
import { requireCapability } from "../../../utils/adminAuthorization";
import { getAuditContext } from "../../../utils/audit-context";
import { writeAuditEvent } from "../../../audit/writer";
import { resolveUserFullName } from "../../../utils/userDisplayName";
import { consumeIssueReportRateLimit } from "../services/rate-limit";
import {
  createIssueReport,
  exportIssueReports,
  findIssueReport,
  IssueReportError,
  queryIssueReports,
  updateIssueReportStatus,
  validateCreateIssueReportPayload,
  type IssueReportQuery,
  type IssueReportStatus,
} from "../services/issue-report";

const ADMIN_FILTER_KEYS = new Set(["cursor", "limit", "status", "search", "from", "to"]);
const STATUS_LABELS: Record<IssueReportStatus, string> = {
  new: "جدید",
  in_review: "در حال بررسی",
  resolved: "رسیدگی‌شده",
};

function incrementMetric(name: string) {
  const metrics = (strapi as any).metrics;
  if (typeof metrics?.increment === "function") metrics.increment(name);
  else metrics?.counter?.(name)?.inc?.();
}

function observeMetric(name: string, value: number) {
  const metrics = (strapi as any).metrics;
  if (typeof metrics?.observe === "function") metrics.observe(name, value);
  else metrics?.histogram?.(name)?.observe?.(value);
}

function issueError(ctx: any, error: unknown, operation: string) {
  if (error instanceof IssueReportError) {
    if (operation === "create") {
      if (error.status === 429) incrementMetric("issue_reports_rate_limited_total");
      else if ([400, 413, 415].includes(error.status))
        incrementMetric("issue_reports_validation_failed_total");
      else incrementMetric("issue_reports_persistence_failed_total");
    }
    const retryAfter = Number(error.details?.retryAfterSeconds);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      ctx.set("Retry-After", String(Math.ceil(retryAfter)));
    }
    ctx.status = error.status;
    ctx.body = {
      error: {
        status: error.status,
        name: error.name,
        message: error.message,
        details: { data: { errorCode: error.code, ...(error.details || {}) } },
      },
    };
    return;
  }

  const databaseCode =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  const internalCode = error instanceof Error ? error.message : "";
  const temporarilyUnavailable =
    databaseCode.startsWith("08") ||
    ["57014", "53300", "57P01", "57P03", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"].includes(
      databaseCode,
    ) ||
    internalCode.startsWith("ISSUE_REPORT_RATE_") ||
    internalCode === "ISSUE_REPORT_SOURCE_UNAVAILABLE";
  if (operation === "create") incrementMetric("issue_reports_persistence_failed_total");
  Sentry.captureException(
    new Error(`Issue report ${operation} failed: ${databaseCode || "UNEXPECTED"}`),
    {
      tags: { operation, databaseCode: databaseCode || "none" },
    },
  );
  strapi.log.error("Issue report operation failed", {
    operation,
    reasonCode: databaseCode || (error instanceof Error ? error.name : "UNKNOWN"),
  });
  ctx.status = temporarilyUnavailable ? 503 : 500;
  ctx.body = {
    error: {
      status: ctx.status,
      name: temporarilyUnavailable ? "ServiceUnavailableError" : "ApplicationError",
      message: temporarilyUnavailable
        ? "ثبت گزارش موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید."
        : "خطایی رخ داد. دوباره تلاش کنید.",
      details: {
        data: {
          errorCode: temporarilyUnavailable ? "ISSUE_REPORT_UNAVAILABLE" : "ISSUE_REPORT_FAILED",
        },
      },
    },
  };
}

function parseFilters(raw: unknown): IssueReportQuery {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new IssueReportError("ISSUE_REPORT_FILTER_INVALID", 400, "فیلترها نامعتبر است.");
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ADMIN_FILTER_KEYS.has(key))) {
    throw new IssueReportError("ISSUE_REPORT_FILTER_INVALID", 400, "فیلتر ناشناخته است.");
  }
  return {
    cursor: typeof record.cursor === "string" ? record.cursor : undefined,
    limit: record.limit == null ? undefined : Number(record.limit),
    status: typeof record.status === "string" ? (record.status as IssueReportStatus) : undefined,
    search: typeof record.search === "string" ? record.search : undefined,
    from: typeof record.from === "string" ? record.from : undefined,
    to: typeof record.to === "string" ? record.to : undefined,
  };
}

function technicalSummary(report: any): string {
  const context = report.clientContext || {};
  const parts = [
    context.viewport ? `نمایش ${context.viewport.width}×${context.viewport.height}` : null,
    context.screen
      ? `صفحه ${context.screen.width}×${context.screen.height} @${context.screen.pixelRatio}`
      : null,
    context.timeZone || null,
    context.language || null,
    context.online === false ? "آفلاین" : context.online === true ? "آنلاین" : null,
    context.connectionType || null,
  ];
  return parts.filter(Boolean).join(" | ");
}

export default {
  async create(ctx: any) {
    const startedAt = Date.now();
    incrementMetric("issue_reports_submission_attempts_total");
    try {
      if (!ctx.is("application/json")) {
        throw new IssueReportError(
          "ISSUE_REPORT_CONTENT_TYPE",
          415,
          "گزارش باید با قالب JSON ارسال شود.",
        );
      }
      let rate;
      try {
        rate = await consumeIssueReportRateLimit(ctx);
      } catch {
        incrementMetric("issue_reports_rate_limiter_failed_total");
        throw new IssueReportError(
          "ISSUE_REPORT_RATE_UNAVAILABLE",
          503,
          "ثبت گزارش موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.",
          { retryAfterSeconds: 10 },
        );
      }
      if (rate.allowed === false) {
        throw new IssueReportError(
          "ISSUE_REPORT_RATE_LIMITED",
          429,
          "تعداد ارسال‌ها زیاد است. کمی بعد دوباره تلاش کنید.",
          { retryAfterSeconds: rate.retryAfterSeconds },
        );
      }
      const input = validateCreateIssueReportPayload(ctx.request.body);
      const request = getAuditContext();
      const userId = Number(ctx.state?.user?.id);
      const result = await createIssueReport(strapi, input, {
        reporterUserId: Number.isSafeInteger(userId) && userId > 0 ? userId : null,
        requestId: request?.requestId || ctx.state?.requestId || null,
        userAgent: String(ctx.get("user-agent") || "").slice(0, 512) || null,
      });
      ctx.status = result.replayed ? 200 : 201;
      ctx.set("Cache-Control", "no-store");
      ctx.body = { data: result };
      incrementMetric("issue_reports_accepted_total");
      if (result.replayed) incrementMetric("issue_reports_idempotent_replays_total");
    } catch (error) {
      issueError(ctx, error, "create");
    } finally {
      observeMetric("issue_reports_submission_duration_ms", Date.now() - startedAt);
    }
  },

  async query(ctx: any) {
    if (!(await requireCapability(ctx, strapi, "system.issueReports.manage"))) return;
    try {
      ctx.set("Cache-Control", "no-store");
      ctx.body = { data: await queryIssueReports(strapi, parseFilters(ctx.query || {})) };
    } catch (error) {
      issueError(ctx, error, "query");
    }
  },

  async findOne(ctx: any) {
    if (!(await requireCapability(ctx, strapi, "system.issueReports.manage"))) return;
    try {
      const report = await findIssueReport(strapi, String(ctx.params?.reportId || ""));
      if (!report) return ctx.notFound("گزارش یافت نشد");
      ctx.set("Cache-Control", "no-store");
      ctx.body = { data: report };
    } catch (error) {
      issueError(ctx, error, "findOne");
    }
  },

  async updateStatus(ctx: any) {
    const actor = await requireCapability(ctx, strapi, "system.issueReports.manage");
    if (!actor) return;
    try {
      const body = ctx.request.body || {};
      if (
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !["status", "expectedVersion"].includes(key))
      ) {
        throw new IssueReportError(
          "ISSUE_REPORT_STATUS_INVALID",
          400,
          "درخواست تغییر وضعیت نامعتبر است.",
        );
      }
      const result = await updateIssueReportStatus(
        strapi,
        String(ctx.params?.reportId || ""),
        body.status as IssueReportStatus,
        Number(body.expectedVersion),
        actor,
      );
      if (result.kind === "not-found") return ctx.notFound("گزارش یافت نشد");
      if (result.kind === "conflict") {
        ctx.status = 409;
        ctx.body = {
          error: {
            status: 409,
            message: "وضعیت گزارش تغییر کرده است.",
            details: { data: { errorCode: "ISSUE_REPORT_CONFLICT", ...result.current } },
          },
        };
        return;
      }
      ctx.body = { data: result.data };
    } catch (error) {
      issueError(ctx, error, "updateStatus");
    }
  },

  async exportReport(ctx: any) {
    const actor = await requireCapability(ctx, strapi, "system.issueReports.manage");
    if (!actor) return;
    try {
      const filters = parseFilters(ctx.request.body?.filters || {});
      delete filters.cursor;
      delete filters.limit;
      const reports = await exportIssueReports(strapi, filters);
      const buffer = await buildStyledWorkbook({
        sheetName: "گزارش مشکلات",
        columns: [
          { header: "زمان ثبت", width: 24 },
          { header: "زمان دستگاه", width: 24 },
          { header: "عنوان", width: 34 },
          { header: "توضیحات", width: 60 },
          { header: "شماره تماس", width: 18 },
          { header: "وضعیت", width: 16 },
          { header: "صفحه", width: 40 },
          { header: "اطلاعات فنی", width: 55 },
          { header: "مرورگر و دستگاه", width: 60 },
          { header: "شناسه گزارش", width: 38 },
        ],
        rows: reports.map((report: any) => [
          report.submittedAt,
          report.clientContext?.clientTime || "",
          report.issueName,
          report.description,
          report.contactNumber,
          STATUS_LABELS[report.status as IssueReportStatus],
          report.sourcePath || "",
          technicalSummary(report),
          report.userAgent || "",
          report.reportId,
        ]),
      });

      const actorName =
        resolveUserFullName(actor.user) ||
        actor.user.email ||
        actor.user.username ||
        `User ${actor.user.id}`;
      await writeAuditEvent(strapi, {
        eventKey: "issue_reports.export_generated",
        initiator: { type: "human", id: actor.user.id, label: actorName, role: actor.role },
        actor: { type: "human", id: actor.user.id, label: actorName, role: actor.role },
        origin: "admin_ui",
        target: { type: "issue_report_export", label: "خروجی گزارش مشکلات" },
        metadata: {
          rowCount: reports.length,
          filtered: Boolean(filters.status || filters.search || filters.from || filters.to),
        },
        dedupeKey: `issue-report-export:${actor.user.id}:${
          getAuditContext()?.requestId || Date.now()
        }`,
      });
      ctx.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      ctx.set("Content-Disposition", `attachment; filename="issue-reports-${Date.now()}.xlsx"`);
      ctx.set("Cache-Control", "no-store");
      ctx.body = buffer;
    } catch (error) {
      issueError(ctx, error, "export");
    }
  },
};
