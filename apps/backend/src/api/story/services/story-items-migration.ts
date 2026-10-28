import { createHash } from "node:crypto";
import { legacyStoryItemKey } from "../lib/story-items";

const MIGRATION_KEY = "story-items-and-item-seen-v1";

export type StoryItemsMigrationReport = {
  scanned: number;
  migrated: number;
  skipped: number;
  invalid: number;
  seenMigrated: number;
  seenDuplicatesRemoved: number;
  verified: number;
  complete: boolean;
};

export function storySeenDedupeKey(userId: number, storyId: number, itemKey: string): string {
  return createHash("sha256").update(`${userId}:${storyId}:${itemKey}`).digest("hex");
}

function relationId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    const id = Number((value as { id?: unknown }).id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  return null;
}

/**
 * One-to-one migration only: every legacy row becomes one item and no WordPress rows are
 * grouped. It is safe to re-run; the checkpoint is an audit record, not the sole guard.
 */
export async function ensureStoryItemsMigration(strapi: any): Promise<StoryItemsMigrationReport> {
  const report: StoryItemsMigrationReport = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    invalid: 0,
    seenMigrated: 0,
    seenDuplicatesRemoved: 0,
    verified: 0,
    complete: false,
  };

  const stories = (await strapi.entityService.findMany("api::story.story", {
    populate: {
      Media: true,
      Thumbnail: true,
      Items: { populate: { Media: true, Thumbnail: true } },
    },
    sort: ["id:asc"],
    limit: -1,
  })) as any[];
  report.scanned = stories.length;

  for (const story of stories) {
    if (Array.isArray(story.Items) && story.Items.length > 0) {
      report.skipped += 1;
      continue;
    }
    if (!story.Media?.id) {
      report.invalid += 1;
      strapi.log.warn(`[story-migration] story ${story.id} has no media; left unchanged`);
      continue;
    }
    try {
      await strapi.entityService.update("api::story.story", story.id, {
        data: {
          Items: [
            {
              Key: legacyStoryItemKey(story.id),
              MediaType: story.MediaType ?? "image",
              Media: story.Media.id,
              Thumbnail: story.Thumbnail?.id ?? null,
              DurationMs: story.DurationMs ?? 5000,
              CtaUrl: story.CtaUrl ?? null,
              CtaLabel: story.CtaLabel ?? null,
              Overlays: Array.isArray(story.Overlays) ? story.Overlays : [],
            },
          ],
        },
      });
      report.migrated += 1;
    } catch (error) {
      report.invalid += 1;
      strapi.log.warn(
        `[story-migration] story ${story.id} could not be migrated: ${(error as Error).message}`,
      );
    }
  }

  const seenRows = (await strapi.db.query("api::story-seen.story-seen").findMany({
    populate: { story: { select: ["id"] }, user: { select: ["id"] } },
    orderBy: { id: "asc" },
  })) as any[];
  const retained = new Map<string, number>();
  for (const row of seenRows) {
    const storyId = relationId(row.story);
    const userId = relationId(row.user);
    if (!storyId || !userId) continue;
    const itemKey =
      typeof row.ItemKey === "string" && row.ItemKey ? row.ItemKey : legacyStoryItemKey(storyId);
    const dedupeKey = storySeenDedupeKey(userId, storyId, itemKey);
    const priorId = retained.get(dedupeKey);
    if (priorId) {
      await strapi.entityService.delete("api::story-seen.story-seen", row.id);
      report.seenDuplicatesRemoved += 1;
      continue;
    }
    retained.set(dedupeKey, row.id);
    if (row.ItemKey !== itemKey || row.DedupeKey !== dedupeKey) {
      await strapi.entityService.update("api::story-seen.story-seen", row.id, {
        data: { ItemKey: itemKey, DedupeKey: dedupeKey },
      });
      report.seenMigrated += 1;
    }
  }

  const verifiedStories = (await strapi.entityService.findMany("api::story.story", {
    fields: ["id"],
    populate: { Items: { fields: ["Key"] } },
    limit: -1,
  })) as Array<{ Items?: Array<{ Key?: string }> }>;
  report.verified = verifiedStories.filter(
    (story) =>
      Array.isArray(story.Items) &&
      story.Items.length >= 1 &&
      story.Items.length <= 20 &&
      story.Items.every((item) => Boolean(item.Key)),
  ).length;
  report.complete = report.invalid === 0 && report.verified === report.scanned;

  const migrationStore = strapi.store({ type: "core", name: "migrations" });
  await migrationStore.set({
    key: MIGRATION_KEY,
    value: { ...report, executedAt: new Date().toISOString() },
  });
  strapi.log.info("Story item migration checked", report);
  return report;
}
