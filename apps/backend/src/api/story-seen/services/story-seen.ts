import { factories } from "@strapi/strapi";
import { storyItemKeys } from "../../story/lib/story-items";
import { storySeenDedupeKey } from "../../story/services/story-items-migration";

type SeenItems = { storyId: number; itemKeys: string[] };

function relationId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    const id = Number((value as { id?: unknown }).id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  return null;
}

export function createStorySeenService(strapi: any) {
  return {
    async getStoryItemKeys(storyId: number): Promise<string[] | null> {
      const story = (await strapi.entityService.findOne("api::story.story", storyId, {
        fields: ["id"],
        populate: { Items: { fields: ["Key"] } },
      })) as { id: number; Items?: Array<{ Key?: string }> } | null;
      return story ? storyItemKeys(story) : null;
    },

    async markItemSeen(
      userId: number,
      storyId: number,
      itemKey: string,
    ): Promise<{ created: boolean }> {
      const keys = await this.getStoryItemKeys(storyId);
      if (!keys) throw Object.assign(new Error("STORY_NOT_FOUND"), { code: "STORY_NOT_FOUND" });
      if (!keys.includes(itemKey)) {
        throw Object.assign(new Error("ITEM_NOT_FOUND"), { code: "ITEM_NOT_FOUND" });
      }

      const dedupeKey = storySeenDedupeKey(userId, storyId, itemKey);
      const existing = await strapi.db.query("api::story-seen.story-seen").findOne({
        where: { DedupeKey: dedupeKey },
        select: ["id"],
      });
      if (existing) return { created: false };

      try {
        await strapi.entityService.create("api::story-seen.story-seen", {
          data: {
            user: userId,
            story: storyId,
            ItemKey: itemKey,
            DedupeKey: dedupeKey,
            SeenAt: new Date(),
          },
        });
        return { created: true };
      } catch (error) {
        // The unique DedupeKey is the concurrency boundary. If another request won the
        // race, return the same idempotent response; otherwise preserve the real failure.
        const raced = await strapi.db.query("api::story-seen.story-seen").findOne({
          where: { DedupeKey: dedupeKey },
          select: ["id"],
        });
        if (raced) return { created: false };
        throw error;
      }
    },

    /** Legacy compatibility: mark the current first item only. */
    async markSeen(userId: number, storyId: number): Promise<{ created: boolean }> {
      const keys = await this.getStoryItemKeys(storyId);
      if (!keys) throw Object.assign(new Error("STORY_NOT_FOUND"), { code: "STORY_NOT_FOUND" });
      return this.markItemSeen(userId, storyId, keys[0]);
    },

    async getSeenItems(userId: number): Promise<SeenItems[]> {
      const rows = (await strapi.db.query("api::story-seen.story-seen").findMany({
        where: { user: userId },
        select: ["ItemKey"],
        populate: { story: { select: ["id"] } },
        orderBy: { SeenAt: "asc" },
      })) as Array<{ story?: unknown; ItemKey?: string | null }>;
      const grouped = new Map<number, Set<string>>();
      for (const row of rows) {
        const storyId = relationId(row.story);
        if (!storyId || !row.ItemKey) continue;
        const keys = grouped.get(storyId) ?? new Set<string>();
        keys.add(row.ItemKey);
        grouped.set(storyId, keys);
      }
      return [...grouped.entries()].map(([storyId, keys]) => ({
        storyId,
        itemKeys: [...keys],
      }));
    },

    /** Legacy compatibility: any item record makes the story appear seen. */
    async getSeenStoryIds(userId: number): Promise<number[]> {
      return (await this.getSeenItems(userId)).map((entry) => entry.storyId);
    },
  };
}

export default factories.createCoreService(
  "api::story-seen.story-seen",
  ({ strapi }: { strapi: any }) => createStorySeenService(strapi),
);
