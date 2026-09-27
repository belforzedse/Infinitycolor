import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import type { Strapi } from "@strapi/strapi";
import {
  publishScheduledProduct,
  recordScheduledPublicationTransientFailure,
  runPublicationEffects,
} from "../api/product/services/product-publication";
import type { ScheduledProductPublicationJobData } from "../queue/contracts";
import type { AuditJobContext } from "../audit/types";
import {
  enqueueScheduledProductPublication,
  scheduledProductJobExists,
} from "../queue/product-publication-queue";

const RECONCILIATION_LIMIT = 100;
const FUTURE_REPAIR_HORIZON_MS = 24 * 60 * 60 * 1000;

type ScheduledRow = {
  id: number;
  scheduled_publish_at: string | Date;
  scheduled_publish_revision: number;
  scheduled_publish_failure_kind: "Transient" | "Permanent" | null;
  scheduled_publish_next_retry_at: string | Date | null;
  scheduled_publish_audit_context: AuditJobContext | string | null;
};

type EffectsRow = {
  id: number;
  publication_revision: number;
};

export async function processScheduledProductPublicationJob(
  strapi: Strapi,
  job: Job<ScheduledProductPublicationJobData>,
  token?: string,
): Promise<unknown> {
  const data = job.data;
  if (
    !Number.isSafeInteger(data?.productId) ||
    data.productId <= 0 ||
    !Number.isSafeInteger(data?.scheduleRevision) ||
    data.scheduleRevision <= 0 ||
    !data.expectedPublishAt ||
    Number.isNaN(Date.parse(data.expectedPublishAt))
  ) {
    throw new UnrecoverableError("SCHEDULED_PUBLICATION_JOB_INVALID");
  }

  strapi.log.info("[product-publication] scheduled publication started", {
    productId: data.productId,
    scheduleRevision: data.scheduleRevision,
    scheduledPublishAt: data.expectedPublishAt,
    jobId: job.id,
  });

  let attempt;
  try {
    attempt = await publishScheduledProduct(strapi, {
      ...data,
      jobId: job.id,
    });
  } catch (error) {
    const attemptsMade = Number(job.attemptsMade || 0);
    const retryDelayMs = 30_000 * (2 ** Math.min(attemptsMade, 4));
    try {
      await recordScheduledPublicationTransientFailure(strapi, {
        ...data,
        error,
        retryDelayMs,
      });
    } catch (persistenceError) {
      strapi.log.error("[product-publication] transient failure state could not be persisted", {
        productId: data.productId,
        scheduleRevision: data.scheduleRevision,
        error: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
      });
    }
    throw error;
  }
  if (attempt.outcome === "early") {
    const dueAt = Date.parse(attempt.dueAt || data.expectedPublishAt);
    if (token && Number.isFinite(dueAt)) {
      await job.moveToDelayed(dueAt, token);
      throw new DelayedError();
    }
    return { outcome: "early", dueAt: attempt.dueAt };
  }
  if (attempt.outcome === "permanent-failure") {
    throw new UnrecoverableError(attempt.code);
  }
  if (attempt.outcome === "published" || attempt.outcome === "already-published") {
    await runPublicationEffects(
      strapi,
      data.productId,
      attempt.result.publicationRevision || undefined,
    );
  }
  if (attempt.outcome === "stale") {
    strapi.log.info("[product-publication] stale delayed job ignored", {
      productId: data.productId,
      scheduleRevision: data.scheduleRevision,
      scheduledPublishAt: data.expectedPublishAt,
      jobId: job.id,
    });
  }
  return { outcome: attempt.outcome };
}

async function repairScheduledRow(
  strapi: Strapi,
  row: ScheduledRow,
  nowMs: number,
): Promise<"queued" | "present" | "skipped"> {
  if (row.scheduled_publish_failure_kind === "Permanent") return "skipped";
  const publishAt = new Date(row.scheduled_publish_at).toISOString();
  if (
    row.scheduled_publish_next_retry_at &&
    Date.parse(String(row.scheduled_publish_next_retry_at)) > nowMs
  ) {
    return "skipped";
  }
  if (await scheduledProductJobExists(row.id, Number(row.scheduled_publish_revision))) {
    return "present";
  }
  await enqueueScheduledProductPublication({
    productId: row.id,
    scheduleRevision: Number(row.scheduled_publish_revision),
    expectedPublishAt: publishAt,
    auditContext: typeof row.scheduled_publish_audit_context === "string"
      ? JSON.parse(row.scheduled_publish_audit_context)
      : row.scheduled_publish_audit_context || undefined,
  });
  strapi.log.warn("[product-publication] reconciliation repaired missing delayed job", {
    productId: row.id,
    scheduleRevision: Number(row.scheduled_publish_revision),
    scheduledPublishAt: publishAt,
  });
  return "queued";
}

/**
 * Database-authoritative recovery pass. Due schedules are always included;
 * future schedules enter the repair window 24h before their target. Pending
 * publication cache effects are repaired independently from product state.
 */
export async function runScheduledProductsReconciliation(
  strapi: Strapi,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ scanned: number; queued: number; present: number; skipped: number; effects: number; effectFailures: number }> {
  const now = opts.now || new Date();
  const limit = opts.limit ?? RECONCILIATION_LIMIT;
  const horizon = new Date(now.getTime() + FUTURE_REPAIR_HORIZON_MS).toISOString();
  const rows = (await strapi.db.connection("products")
    .select([
      "id",
      "scheduled_publish_at",
      "scheduled_publish_revision",
      "scheduled_publish_failure_kind",
      "scheduled_publish_next_retry_at",
      "scheduled_publish_audit_context",
    ])
    .where({ status: "Scheduled" })
    // A trashed row keeps no live schedule (trash retires it), but legacy or
    // rolled-back rows can; never re-queue a publish for a product in Trash.
    .whereNull("removed_at")
    .whereNotNull("scheduled_publish_at")
    .andWhere("scheduled_publish_at", "<=", horizon)
    .orderBy("scheduled_publish_at", "asc")
    .limit(limit)) as ScheduledRow[];

  const summary = { scanned: rows.length, queued: 0, present: 0, skipped: 0, effects: 0, effectFailures: 0 };
  for (const row of rows) {
    try {
      const outcome = await repairScheduledRow(strapi, row, now.getTime());
      summary[outcome] += 1;
    } catch (error) {
      summary.skipped += 1;
      strapi.log.error("[product-publication] reconciliation queue repair failed", {
        productId: row.id,
        scheduleRevision: row.scheduled_publish_revision,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Deliberately not filtered on removed_at: moving a published product to
  // Trash bumps its revision precisely so these cache effects run.
  const pendingEffects = (await strapi.db.connection("products")
    .select(["id", "publication_revision"])
    .whereRaw("publication_revision > publication_effects_completed_revision")
    .orderBy("updated_at", "asc")
    .limit(limit)) as EffectsRow[];
  for (const row of pendingEffects) {
    try {
      await runPublicationEffects(strapi, row.id, Number(row.publication_revision));
      summary.effects += 1;
    } catch {
      summary.effectFailures += 1;
    }
  }

  return summary;
}

// Compatibility export retained for existing operational/tests imports. Its
// semantics are now reconciliation, not direct raw-SQL publication.
export const runPublishScheduledProductsTick = runScheduledProductsReconciliation;
