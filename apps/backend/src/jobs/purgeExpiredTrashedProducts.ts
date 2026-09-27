import type { Strapi } from "@strapi/strapi";
import { PublicationCommandError } from "../api/product/services/product-publication";
import { purgeProductInTransaction } from "../api/product/services/product-lifecycle";
import {
  ensureRetentionEnabledSince,
  readTrashRetentionConfig,
  retentionCutoff,
} from "../api/product/services/product-trash-retention";

/**
 * Trash retention sweep (daily, BullMQ scheduler — see queue/scheduler-registration.ts).
 *
 * Permanently deletes (tombstones) products that have sat in Trash longer than
 * `PRODUCT_TRASH_RETENTION_DAYS`. Off by default; see product-trash-retention.ts
 * for the policy and why enabling it never sweeps a backlog at once.
 *
 * Safety:
 *  - only rows with `removed_at IS NOT NULL AND purged_at IS NULL` at or before
 *    the cut-off are selected, and a removed_at in the future never is;
 *  - each product is purged in its own row-locked transaction that re-checks the
 *    trash state and the cut-off, so a product restored (or re-trashed) while
 *    the sweep runs is left alone — restore wins;
 *  - a purged product is a no-op, so the sweep is idempotent and retry-safe.
 */

export const TRASH_RETENTION_BATCH_SIZE = 100;
export const TRASH_RETENTION_MAX_BATCHES = 20;

export type TrashRetentionSummary = {
  status: "disabled" | "invalid-config" | "not-due" | "completed";
  days?: number;
  cutoff?: string;
  scanned: number;
  purged: number;
  skipped: number;
  failed: number;
};

export async function runTrashRetentionSweep(
  strapi: Strapi,
  opts: { now?: Date; env?: NodeJS.ProcessEnv; batchSize?: number; maxBatches?: number } = {},
): Promise<TrashRetentionSummary> {
  const now = opts.now || new Date();
  const summary: TrashRetentionSummary = { status: "completed", scanned: 0, purged: 0, skipped: 0, failed: 0 };
  const config = readTrashRetentionConfig(opts.env);
  if (config.enabled === false) {
    if (config.reason === "invalid") {
      strapi.log.error("[product-trash-retention] PRODUCT_TRASH_RETENTION_DAYS is malformed; nothing deleted", {
        value: config.raw,
      });
      return { ...summary, status: "invalid-config" };
    }
    return { ...summary, status: "disabled" };
  }

  const enabledSince = await ensureRetentionEnabledSince(strapi, now);
  const cutoff = retentionCutoff(now, enabledSince, config.days);
  if (!cutoff) {
    strapi.log.info("[product-trash-retention] retention period not reached since enablement", {
      days: config.days,
      enabledSince: enabledSince.toISOString(),
    });
    return { ...summary, status: "not-due", days: config.days };
  }

  const batchSize = opts.batchSize ?? TRASH_RETENTION_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? TRASH_RETENTION_MAX_BATCHES;
  const attempted = new Set<number>();
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = (await strapi.db
      .connection("products")
      .select("id")
      .whereNotNull("removed_at")
      .whereNull("purged_at")
      .where("removed_at", "<=", cutoff)
      .whereNotIn("id", [...attempted])
      .orderBy([{ column: "removed_at", order: "asc" }, { column: "id", order: "asc" }])
      .limit(batchSize)) as Array<{ id: number }>;
    if (rows.length === 0) break;

    for (const { id } of rows) {
      const productId = Number(id);
      attempted.add(productId);
      summary.scanned += 1;
      try {
        const result = await purgeProductInTransaction(
          strapi,
          productId,
          { origin: "retention", now },
          { trashedBefore: cutoff },
        );
        if (result.changed) summary.purged += 1;
        else summary.skipped += 1;
      } catch (error) {
        if (error instanceof PublicationCommandError && error.code === "PRODUCT_NOT_IN_TRASH") {
          // Restored between the select and the lock.
          summary.skipped += 1;
          continue;
        }
        summary.failed += 1;
        strapi.log.error("[product-trash-retention] purge failed", {
          productId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (rows.length < batchSize) break;
  }

  strapi.log.info("[product-trash-retention] sweep completed", {
    days: config.days,
    cutoff: cutoff.toISOString(),
    ...summary,
  });
  return { ...summary, days: config.days, cutoff: cutoff.toISOString() };
}
