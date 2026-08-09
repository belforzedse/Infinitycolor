import type { Strapi } from "@strapi/strapi";
import { recordAdminAudit, type AdminAuditActor } from "../../../utils/adminAudit";
import { delByPatternStrict } from "../../../utils/responseCache";
import { triggerFrontendRevalidation } from "../../../utils/revalidate";

export const PRODUCT_UID = "api::product.product" as const;
export const BUSINESS_TIMEZONE = "Asia/Tehran";

export type ProductPublicationStatus = "Active" | "InActive" | "Scheduled";
export type PublicationOrigin = "admin" | "scheduler" | "importer" | "reconciler";
export type PublicationAction = "schedule" | "publish-now" | "cancel" | "retry" | "unpublish";
export type QueueState = "queued" | "pending-reconciliation" | "not-required";

export type PublicationCommand = {
  action: PublicationAction;
  publishAt?: string;
  timezone?: string;
  requireMedia?: boolean;
  expectedExternalSource?: string;
  expectedExternalId?: string;
};

export type PublicationActor = AdminAuditActor & {
  ip?: string | null;
  userAgent?: string | null;
};

export type PublicationCommandContext = {
  origin: PublicationOrigin;
  actor?: PublicationActor;
  now?: Date;
};

export type PublicationResult = {
  productId: number;
  status: ProductPublicationStatus;
  scheduledPublishAt: string | null;
  scheduledPublishTimezone: string | null;
  scheduleRevision: number;
  publicationRevision: number;
  previousScheduleRevision?: number;
  changed: boolean;
  needsPublicationEffects: boolean;
};

export class PublicationCommandError extends Error {
  code: string;
  status: number;
  permanent: boolean;

  constructor(code: string, status = 400, permanent = true) {
    super(code);
    this.name = "PublicationCommandError";
    this.code = code;
    this.status = status;
    this.permanent = permanent;
  }
}

type ProductRow = {
  id: number;
  title: string | null;
  slug: string | null;
  status: ProductPublicationStatus | null;
  removed_at: string | Date | null;
  external_source: string | null;
  external_id: string | null;
  scheduled_publish_at: string | Date | null;
  scheduled_publish_timezone: string | null;
  scheduled_publish_revision: number | null;
  scheduled_publish_require_media: boolean | null;
  scheduled_publish_last_attempt_at: string | Date | null;
  scheduled_publish_last_error: string | null;
  scheduled_publish_failure_kind: string | null;
  scheduled_publish_attempt_count: number | null;
  scheduled_publish_next_retry_at: string | Date | null;
  publication_revision: number | null;
  publication_effects_completed_revision: number | null;
  publication_effects_last_error: string | null;
};

const productTable = (trx: any) => trx("products");

function canonicalInstant(value: unknown, now: Date): string {
  const text = String(value ?? "").trim();
  if (!text || !/(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new PublicationCommandError("INVALID_PUBLICATION_TIME", 422);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    throw new PublicationCommandError("INVALID_PUBLICATION_TIME", 422);
  }
  return parsed.toISOString();
}

function canonicalTimezone(value: unknown): string {
  const timezone = String(value || BUSINESS_TIMEZONE).trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new PublicationCommandError("INVALID_PUBLICATION_TIMEZONE", 422);
  }
  if (timezone !== BUSINESS_TIMEZONE) {
    throw new PublicationCommandError("UNSUPPORTED_PUBLICATION_TIMEZONE", 422);
  }
  return timezone;
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  const parsed = new Date(value as string | Date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function assertExternalIdentity(row: ProductRow, command: PublicationCommand): void {
  if (!command.expectedExternalSource && !command.expectedExternalId) return;
  if (
    String(row.external_source || "") !== String(command.expectedExternalSource || "") ||
    String(row.external_id || "") !== String(command.expectedExternalId || "")
  ) {
    throw new PublicationCommandError("EXTERNAL_PRODUCT_MISMATCH", 409);
  }
}

function assertPublishable(row: ProductRow): void {
  if (row.removed_at) throw new PublicationCommandError("PRODUCT_REMOVED", 422);
  if (!String(row.title || "").trim()) {
    throw new PublicationCommandError("PRODUCT_TITLE_REQUIRED", 422);
  }
  if (!String(row.slug || "").trim()) {
    throw new PublicationCommandError("PRODUCT_SLUG_REQUIRED", 422);
  }
}

function hasMediaRelation(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null && "data" in value) {
    const data = (value as { data?: unknown }).data;
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
  }
  return true;
}

async function assertRequiredMedia(strapi: Strapi, productId: number, required: boolean): Promise<void> {
  if (!required) return;
  const product = await strapi.entityService.findOne(PRODUCT_UID, productId, {
    populate: { CoverImage: true },
    fields: ["id"],
  } as any);
  if (!hasMediaRelation((product as any)?.CoverImage)) {
    throw new PublicationCommandError("PRODUCT_COVER_MEDIA_REQUIRED", 422);
  }
}

function resultFromRow(row: ProductRow, changed: boolean, previousScheduleRevision?: number): PublicationResult {
  const publicationRevision = Number(row.publication_revision || 0);
  const completedRevision = Number(row.publication_effects_completed_revision || 0);
  return {
    productId: Number(row.id),
    status: (row.status || "InActive") as ProductPublicationStatus,
    scheduledPublishAt: isoOrNull(row.scheduled_publish_at),
    scheduledPublishTimezone: row.scheduled_publish_timezone || null,
    scheduleRevision: Number(row.scheduled_publish_revision || 0),
    publicationRevision,
    previousScheduleRevision,
    changed,
    needsPublicationEffects: publicationRevision > completedRevision,
  };
}

async function writePublicationLog(
  strapi: Strapi,
  result: PublicationResult,
  action: PublicationAction,
  context: PublicationCommandContext,
): Promise<void> {
  if (!result.changed) return;
  const actor = context.actor;
  const actionName =
    action === "schedule" ? "Schedule" :
    action === "cancel" ? "CancelSchedule" :
    action === "retry" ? "Reschedule" :
    action === "unpublish" ? "Unpublish" : "Publish";
  try {
    await strapi.entityService.create("api::product-log.product-log" as any, {
      data: {
        product: result.productId,
        ...(actor?.id ? { performed_by: actor.id } : {}),
        PerformedBy: actor?.name || context.origin,
        IP: actor?.ip || undefined,
        UserAgent: actor?.userAgent || undefined,
        Action: actionName,
        Description: `Product publication ${action} (${context.origin})`,
        Changes: {
          origin: context.origin,
          scheduleRevision: result.scheduleRevision,
          publicationRevision: result.publicationRevision,
          scheduledPublishAt: result.scheduledPublishAt,
          status: result.status,
        },
      } as never,
    });
  } catch (error) {
    strapi.log.error("[product-publication] audit log write failed", {
      productId: result.productId,
      action,
      origin: context.origin,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!actor?.id) return;
  const adminAction =
    action === "publish-now" ? "Publish" : action === "unpublish" ? "Unpublish" : "StatusChange";
  await recordAdminAudit(strapi, {
    resourceType: "Product",
    resourceId: result.productId,
    action: adminAction,
    actor,
    ip: actor.ip,
    userAgent: actor.userAgent,
    title: `Product publication ${action}`,
    messageEn: `Product #${result.productId} publication action: ${action}`,
    severity: "info",
    metadata: {
      origin: context.origin,
      scheduleRevision: result.scheduleRevision,
      scheduledPublishAt: result.scheduledPublishAt,
      status: result.status,
    },
  });
}

export async function executePublicationCommand(
  strapi: Strapi,
  productId: number,
  command: PublicationCommand,
  context: PublicationCommandContext,
): Promise<PublicationResult> {
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new PublicationCommandError("PRODUCT_ID_INVALID", 400);
  }
  const now = context.now || new Date();

  const result = await strapi.db.transaction(async ({ trx }: any) => {
    const row = (await productTable(trx).where({ id: productId }).forUpdate().first()) as ProductRow | undefined;
    if (!row) throw new PublicationCommandError("PRODUCT_NOT_FOUND", 404);
    assertExternalIdentity(row, command);

    const status = (row.status || "InActive") as ProductPublicationStatus;
    const previousScheduleRevision = Number(row.scheduled_publish_revision || 0);
    const publicationRevision = Number(row.publication_revision || 0);
    let changed = false;

    if (command.action === "schedule") {
      if (status === "Active") {
        throw new PublicationCommandError("SCHEDULED_UPDATE_UNSUPPORTED", 409);
      }
      assertPublishable(row);
      await assertRequiredMedia(strapi, productId, command.requireMedia === true);
      const publishAt = canonicalInstant(command.publishAt, now);
      const timezone = canonicalTimezone(command.timezone);
      const sameSchedule =
        status === "Scheduled" &&
        isoOrNull(row.scheduled_publish_at) === publishAt &&
        row.scheduled_publish_timezone === timezone &&
        row.scheduled_publish_require_media === (command.requireMedia === true) &&
        !row.scheduled_publish_failure_kind;
      if (!sameSchedule) {
        const nextRevision = previousScheduleRevision + 1;
        await productTable(trx).where({ id: productId }).update({
          status: "Scheduled",
          // Strapi maps `datetime` to PostgreSQL `timestamp without time zone`.
          // Bind Date objects so node-postgres preserves the absolute instant
          // across non-UTC process timezones instead of discarding an ISO offset.
          scheduled_publish_at: new Date(publishAt),
          scheduled_publish_timezone: timezone,
          scheduled_publish_revision: nextRevision,
          scheduled_publish_require_media: command.requireMedia === true,
          scheduled_publish_last_attempt_at: null,
          scheduled_publish_last_error: null,
          scheduled_publish_failure_kind: null,
          scheduled_publish_attempt_count: 0,
          scheduled_publish_next_retry_at: null,
          updated_at: now,
        });
        changed = true;
      }
    } else if (command.action === "retry") {
      if (status !== "Scheduled" || !row.scheduled_publish_at) {
        throw new PublicationCommandError("PRODUCT_NOT_SCHEDULED", 409);
      }
      await productTable(trx).where({ id: productId }).update({
        scheduled_publish_revision: previousScheduleRevision + 1,
        scheduled_publish_last_attempt_at: null,
        scheduled_publish_last_error: null,
        scheduled_publish_failure_kind: null,
        scheduled_publish_attempt_count: 0,
        scheduled_publish_next_retry_at: null,
        updated_at: now,
      });
      changed = true;
    } else if (command.action === "cancel") {
      if (status === "Active") {
        throw new PublicationCommandError("PRODUCT_NOT_SCHEDULED", 409);
      }
      if (status === "Scheduled") {
        await productTable(trx).where({ id: productId }).update({
          status: "InActive",
          scheduled_publish_at: null,
          scheduled_publish_timezone: null,
          scheduled_publish_revision: previousScheduleRevision + 1,
          scheduled_publish_require_media: false,
          scheduled_publish_last_attempt_at: null,
          scheduled_publish_last_error: null,
          scheduled_publish_failure_kind: null,
          scheduled_publish_attempt_count: 0,
          scheduled_publish_next_retry_at: null,
          updated_at: now,
        });
        changed = true;
      }
    } else if (command.action === "unpublish") {
      if (status !== "InActive") {
        const nextPublicationRevision = status === "Active" ? publicationRevision + 1 : publicationRevision;
        await productTable(trx).where({ id: productId }).update({
          status: "InActive",
          scheduled_publish_at: null,
          scheduled_publish_timezone: null,
          scheduled_publish_revision: previousScheduleRevision + (status === "Scheduled" ? 1 : 0),
          scheduled_publish_require_media: false,
          scheduled_publish_last_attempt_at: null,
          scheduled_publish_last_error: null,
          scheduled_publish_failure_kind: null,
          scheduled_publish_attempt_count: 0,
          scheduled_publish_next_retry_at: null,
          publication_revision: nextPublicationRevision,
          publication_effects_last_error: null,
          updated_at: now,
        });
        changed = true;
      }
    } else if (command.action === "publish-now") {
      if (status !== "Active") {
        assertPublishable(row);
        await assertRequiredMedia(strapi, productId, command.requireMedia === true);
        await productTable(trx).where({ id: productId }).update({
          status: "Active",
          scheduled_publish_at: null,
          scheduled_publish_timezone: null,
          scheduled_publish_revision: previousScheduleRevision + (status === "Scheduled" ? 1 : 0),
          scheduled_publish_require_media: false,
          scheduled_publish_last_attempt_at: now,
          scheduled_publish_last_error: null,
          scheduled_publish_failure_kind: null,
          scheduled_publish_attempt_count: 0,
          scheduled_publish_next_retry_at: null,
          publication_revision: publicationRevision + 1,
          publication_effects_last_error: null,
          updated_at: now,
        });
        changed = true;
      }
    } else {
      throw new PublicationCommandError("PUBLICATION_ACTION_INVALID", 400);
    }

    const updated = (await productTable(trx).where({ id: productId }).first()) as ProductRow;
    return resultFromRow(updated, changed, changed ? previousScheduleRevision : undefined);
  });

  await writePublicationLog(strapi, result, command.action, context);
  strapi.log.info("[product-publication] command completed", {
    productId,
    action: command.action,
    origin: context.origin,
    status: result.status,
    scheduleRevision: result.scheduleRevision,
    changed: result.changed,
  });
  return result;
}

export type ScheduledPublicationAttempt =
  | { outcome: "stale" | "early" | "published" | "already-published"; result: PublicationResult; dueAt?: string }
  | { outcome: "permanent-failure"; code: string; result: PublicationResult };

export async function recordScheduledPublicationTransientFailure(
  strapi: Strapi,
  input: {
    productId: number;
    scheduleRevision: number;
    expectedPublishAt: string;
    error: unknown;
    now?: Date;
    retryDelayMs: number;
  },
): Promise<boolean> {
  const row = (await strapi.db.connection("products")
    .where({
      id: input.productId,
      status: "Scheduled",
      scheduled_publish_revision: input.scheduleRevision,
    })
    .first()) as ProductRow | undefined;
  if (!row || isoOrNull(row.scheduled_publish_at) !== isoOrNull(input.expectedPublishAt)) {
    return false;
  }
  const now = input.now || new Date();
  const errorCode = (
    input.error instanceof Error ? input.error.message : String(input.error || "TRANSIENT_PUBLICATION_FAILURE")
  ).slice(0, 255);
  const attempts = Number(row.scheduled_publish_attempt_count || 0) + 1;
  const updated = await strapi.db.connection("products")
    .where({
      id: input.productId,
      status: "Scheduled",
      scheduled_publish_revision: input.scheduleRevision,
    })
    .update({
      scheduled_publish_last_attempt_at: now,
      scheduled_publish_last_error: errorCode,
      scheduled_publish_failure_kind: "Transient",
      scheduled_publish_attempt_count: attempts,
      scheduled_publish_next_retry_at: new Date(now.getTime() + input.retryDelayMs),
      updated_at: now,
    });
  return Number(updated) > 0;
}

export async function publishScheduledProduct(
  strapi: Strapi,
  input: { productId: number; scheduleRevision: number; expectedPublishAt: string; now?: Date },
): Promise<ScheduledPublicationAttempt> {
  const now = input.now || new Date();
  let failureCode: string | null = null;

  const attempt = await strapi.db.transaction(async ({ trx }: any) => {
    const row = (await productTable(trx).where({ id: input.productId }).forUpdate().first()) as ProductRow | undefined;
    if (!row) {
      return { outcome: "stale" as const, result: {
        productId: input.productId,
        status: "InActive" as const,
        scheduledPublishAt: null,
        scheduledPublishTimezone: null,
        scheduleRevision: input.scheduleRevision,
        publicationRevision: 0,
        changed: false,
        needsPublicationEffects: false,
      }};
    }
    const current = resultFromRow(row, false);
    if (row.status === "Active") {
      return { outcome: "already-published" as const, result: current };
    }
    if (
      row.status !== "Scheduled" ||
      Number(row.scheduled_publish_revision || 0) !== input.scheduleRevision ||
      isoOrNull(row.scheduled_publish_at) !== isoOrNull(input.expectedPublishAt)
    ) {
      return { outcome: "stale" as const, result: current };
    }
    const dueAt = isoOrNull(row.scheduled_publish_at);
    if (!dueAt || Date.parse(dueAt) > now.getTime()) {
      return { outcome: "early" as const, dueAt: dueAt || input.expectedPublishAt, result: current };
    }

    try {
      assertPublishable(row);
      await assertRequiredMedia(strapi, input.productId, row.scheduled_publish_require_media === true);
    } catch (error) {
      failureCode = error instanceof PublicationCommandError ? error.code : "PRODUCT_NOT_PUBLISHABLE";
      const attempts = Number(row.scheduled_publish_attempt_count || 0) + 1;
      await productTable(trx).where({ id: input.productId }).update({
        scheduled_publish_last_attempt_at: now,
        scheduled_publish_last_error: failureCode,
        scheduled_publish_failure_kind: "Permanent",
        scheduled_publish_attempt_count: attempts,
        scheduled_publish_next_retry_at: null,
        updated_at: now,
      });
      const blocked = (await productTable(trx).where({ id: input.productId }).first()) as ProductRow;
      return { outcome: "permanent-failure" as const, code: failureCode, result: resultFromRow(blocked, true) };
    }

    const nextPublicationRevision = Number(row.publication_revision || 0) + 1;
    await productTable(trx).where({ id: input.productId }).update({
      status: "Active",
      scheduled_publish_at: null,
      scheduled_publish_timezone: null,
      scheduled_publish_require_media: false,
      scheduled_publish_last_attempt_at: now,
      scheduled_publish_last_error: null,
      scheduled_publish_failure_kind: null,
      scheduled_publish_attempt_count: Number(row.scheduled_publish_attempt_count || 0) + 1,
      scheduled_publish_next_retry_at: null,
      publication_revision: nextPublicationRevision,
      publication_effects_last_error: null,
      updated_at: now,
    });
    const published = (await productTable(trx).where({ id: input.productId }).first()) as ProductRow;
    return { outcome: "published" as const, result: resultFromRow(published, true) };
  });

  if (attempt.outcome === "published") {
    await writePublicationLog(strapi, attempt.result, "publish-now", { origin: "scheduler", now });
  }
  if (attempt.outcome === "permanent-failure") {
    strapi.log.error("[product-publication] scheduled publication permanently blocked", {
      productId: input.productId,
      scheduleRevision: input.scheduleRevision,
      scheduledPublishAt: input.expectedPublishAt,
      errorCode: failureCode,
    });
  }
  return attempt;
}

export async function runPublicationEffects(
  strapi: Strapi,
  productId: number,
  publicationRevision?: number,
): Promise<{ completed: boolean; revision: number }> {
  const row = (await strapi.db.connection("products").where({ id: productId }).first()) as ProductRow | undefined;
  if (!row) return { completed: true, revision: 0 };
  const revision = publicationRevision ?? Number(row.publication_revision || 0);
  if (Number(row.publication_effects_completed_revision || 0) >= revision) {
    return { completed: true, revision };
  }
  try {
    await delByPatternStrict("endpoint-cache:product.");
    const revalidation = await triggerFrontendRevalidation(
      { type: "product", path: String(row.slug || "") },
      "ProductPublication",
    );
    if (revalidation.failed > 0 || revalidation.successful === 0) {
      throw new Error("STOREFRONT_REVALIDATION_FAILED");
    }
    await strapi.db.connection("products")
      .where({ id: productId })
      .andWhere("publication_revision", revision)
      .update({
        publication_effects_completed_revision: revision,
        publication_effects_last_error: null,
      });
    strapi.log.info("[product-publication] publication effects completed", { productId, revision });
    return { completed: true, revision };
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 255) : "PUBLICATION_EFFECTS_FAILED";
    await strapi.db.connection("products")
      .where({ id: productId })
      .andWhere("publication_revision", revision)
      .update({ publication_effects_last_error: code });
    strapi.log.error("[product-publication] publication effects failed", {
      productId,
      revision,
      errorCode: code,
    });
    throw error;
  }
}
