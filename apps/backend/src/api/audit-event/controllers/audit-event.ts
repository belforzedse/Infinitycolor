import { buildStyledWorkbook } from "../../../utils/styledWorkbook";
import { requireCapability } from "../../../utils/adminAuthorization";
import {
  findAuditEvent,
  findAuditEvents,
  findRelatedAuditEvents,
  getAuditFilterOptions,
  getAuditSummary,
} from "../../../audit/query";
import { writeAuditEvent } from "../../../audit/writer";
import type { AuditEventInput, AuditQuery } from "../../../audit/types";

const MAX_EXPORT_ROWS = 10_000;

function first(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function parseQuery(raw: Record<string, unknown>): AuditQuery {
  const limit = Math.min(Math.max(Number(first(raw.limit)) || 50, 1), 100);
  const bool = first(raw.includeChildren);
  const defaultTo = new Date();
  const defaultFrom = new Date(defaultTo.getTime() - 30 * 24 * 60 * 60 * 1_000);
  return {
    from: first(raw.from) || first(raw.startDate) || defaultFrom.toISOString(),
    to: first(raw.to) || first(raw.endDate) || defaultTo.toISOString(),
    mode: (first(raw.mode) || "human") as AuditQuery["mode"],
    initiatorId: first(raw.initiatorId) || first(raw.performedBy),
    actorType: (first(raw.actorType) || first(raw.executorType)) as AuditQuery["actorType"],
    role: first(raw.role),
    origin: (first(raw.origin) || first(raw.source)) as AuditQuery["origin"],
    domain: first(raw.domain),
    eventKey: first(raw.eventKey),
    targetType: first(raw.targetType) || first(raw.resourceType)?.toLowerCase(),
    targetId: first(raw.targetId),
    result: first(raw.result) as AuditQuery["result"],
    importance: first(raw.importance) as AuditQuery["importance"],
    search: first(raw.search),
    correlationId: first(raw.correlationId),
    rootEventId: first(raw.rootEventId),
    cursor: first(raw.cursor),
    limit,
    includeChildren: bool === "true",
  };
}

function eventIdOrRespond(ctx: any): string | null {
  const eventId = String(ctx.params?.eventId || "");
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId);
  const isLegacyId = /^[1-9][0-9]{0,17}$/.test(eventId);
  if (!isUuid && !isLegacyId) {
    ctx.badRequest("شناسه رویداد نامعتبر است");
    return null;
  }
  return eventId;
}

function valueLabel(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export default {
  async find(ctx) {
    if (!(await requireCapability(ctx, strapi, "system.audit.read"))) return;
    ctx.body = await findAuditEvents(strapi, parseQuery(ctx.query || {}));
  },

  async findOne(ctx) {
    if (!(await requireCapability(ctx, strapi, "system.audit.read"))) return;
    const eventId = eventIdOrRespond(ctx);
    if (!eventId) return;
    const event = await findAuditEvent(strapi, eventId);
    if (!event) return ctx.notFound("رویداد یافت نشد");
    ctx.body = { data: event };
  },

  async related(ctx) {
    if (!(await requireCapability(ctx, strapi, "system.audit.read"))) return;
    const eventId = eventIdOrRespond(ctx);
    if (!eventId) return;
    ctx.body = await findRelatedAuditEvents(strapi, eventId, parseQuery(ctx.query || {}));
  },

  async summary(ctx) {
    if (!(await requireCapability(ctx, strapi, "system.audit.read"))) return;
    ctx.body = { data: await getAuditSummary(strapi, parseQuery(ctx.query || {})) };
  },

  async filterOptions(ctx) {
    if (!(await requireCapability(ctx, strapi, "system.audit.read"))) return;
    ctx.body = { data: await getAuditFilterOptions(strapi, parseQuery(ctx.query || {})) };
  },

  async exportReport(ctx) {
    const actor = await requireCapability(ctx, strapi, "system.audit.export");
    if (!actor) return;
    const filters = parseQuery(ctx.request.body?.filters || {});
    const events: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await findAuditEvents(strapi, {
        ...filters,
        includeChildren: true,
        limit: 100,
        cursor,
      });
      events.push(...page.items);
      cursor = page.nextCursor || undefined;
      if (!page.hasMore) break;
    } while (events.length < MAX_EXPORT_ROWS);

    const rows = events.slice(0, MAX_EXPORT_ROWS).map((event) => [
      event.occurredAt,
      event.summaryFa,
      event.initiator?.label || event.initiator?.type,
      event.actor?.label || event.actor?.type,
      event.origin,
      event.target ? `${event.target.type}:${event.target.id || ""}` : "",
      event.result,
      event.importance,
      event.eventId,
      event.changes.map((change) => `${change.label || change.field}: ${valueLabel(change.from)} ← ${valueLabel(change.to)}`).join(" | "),
    ]);
    const buffer = await buildStyledWorkbook({
      sheetName: "رویدادهای حسابرسی",
      columns: [
        { header: "زمان", width: 24 }, { header: "فعالیت", width: 38 },
        { header: "آغازگر", width: 24 }, { header: "اجراکننده", width: 24 },
        { header: "منبع", width: 14 }, { header: "هدف", width: 24 },
        { header: "نتیجه", width: 12 }, { header: "اهمیت", width: 12 },
        { header: "شناسه رویداد", width: 38 }, { header: "تغییرات", width: 60 },
      ],
      rows,
    });

    await strapi.db.transaction(async ({ trx }) => {
      await writeAuditEvent(strapi, {
        eventKey: "audit.export_generated",
        initiator: {
          type: "human",
          id: actor.user.id,
          label: actor.user.username || actor.user.email || `User ${actor.user.id}`,
          role: actor.role,
        },
        actor: {
          type: "human",
          id: actor.user.id,
          label: actor.user.username || actor.user.email,
          role: actor.role,
        },
        origin: "admin_ui",
        target: { type: "audit_report", label: "گزارش رویدادهای حسابرسی" },
        metadata: { filters, rowCount: Math.min(events.length, MAX_EXPORT_ROWS), truncated: events.length >= MAX_EXPORT_ROWS },
        dedupeKey: `audit-export:${actor.user.id}:${ctx.state?.auditExportId || Date.now()}`,
      }, { trx });
    });
    ctx.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    ctx.set("Content-Disposition", `attachment; filename="audit-events-${Date.now()}.xlsx"`);
    ctx.body = buffer;
  },

  async acceptInternal(ctx) {
    const events = Array.isArray(ctx.request.body?.events) ? ctx.request.body.events : [];
    if (!events.length || events.length > 100) return ctx.badRequest("Invalid audit batch");
    const results = await strapi.db.transaction(async ({ trx }) => {
      const output: Array<{ eventId: string; deduplicated: boolean }> = [];
      for (const raw of events as AuditEventInput[]) {
        if (!raw?.dedupeKey || typeof raw.dedupeKey !== "string") {
          throw new Error("Internal audit events require a deterministic dedupeKey");
        }
        if (["human", "impersonated_human"].includes(String(raw.actor?.type))) {
          throw new Error("Internal service delivery cannot impersonate a human actor");
        }
        const written = await writeAuditEvent(strapi, {
          ...raw,
          origin: raw.origin || "internal_api",
          actor: raw.actor || { type: "service_account", id: "auth-service", label: "Infinity Auth" },
        }, { trx });
        output.push({ eventId: written.eventId, deduplicated: written.deduplicated });
      }
      return output;
    });
    ctx.status = 202;
    ctx.body = { data: results };
  },
};
