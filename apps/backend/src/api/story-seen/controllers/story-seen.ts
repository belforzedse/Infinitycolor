/**
 * story-seen controller
 */

import { factories } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../utils/roles";

export default factories.createCoreController(
  "api::story-seen.story-seen",
  ({ strapi }: { strapi: any }) => ({
    /**
     * POST /api/story-seens/mark
     * Body: { storyId: number }
     * Idempotent — safe to call multiple times for the same story.
     */
    async markSeen(ctx: any) {
      const pluginUserId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!pluginUserId) return;

      const { storyId } = ctx.request.body as { storyId?: unknown };

      if (!storyId || typeof storyId !== "number") {
        return ctx.badRequest("شناسه استوری معتبر نیست.");
      }

      const story = await strapi.entityService.findOne("api::story.story", storyId);
      if (!story) {
        return ctx.notFound("استوری یافت نشد.");
      }

      try {
        const storySeenService = strapi.service("api::story-seen.story-seen") as {
          markSeen: (userId: number, storyId: number) => Promise<{ created: boolean }>;
        };
        const result = await storySeenService.markSeen(pluginUserId, storyId);
        return ctx.send({ success: true, created: result.created });
      } catch (error) {
        if ((error as { code?: string }).code === "STORY_NOT_FOUND") {
          return ctx.notFound("استوری یافت نشد.");
        }
        strapi.log.error("Error marking story seen", {
          userId: pluginUserId,
          storyId,
          error: (error as Error)?.message,
        });
        return ctx.internalServerError("خطا در ثبت مشاهده. دوباره تلاش کنید.");
      }
    },

    /** POST /api/story-seens/mark-item — item-level idempotent seen state. */
    async markItemSeen(ctx: any) {
      const pluginUserId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!pluginUserId) return;
      const { storyId, itemKey } = ctx.request.body as {
        storyId?: unknown;
        itemKey?: unknown;
      };
      if (typeof storyId !== "number" || !Number.isInteger(storyId) || storyId <= 0) {
        return ctx.badRequest("شناسه استوری معتبر نیست.");
      }
      if (typeof itemKey !== "string" || !itemKey.trim() || itemKey.length > 64) {
        return ctx.badRequest("شناسه آیتم معتبر نیست.");
      }
      try {
        const service = strapi.service("api::story-seen.story-seen") as {
          markItemSeen: (
            userId: number,
            storyId: number,
            itemKey: string,
          ) => Promise<{ created: boolean }>;
        };
        const result = await service.markItemSeen(pluginUserId, storyId, itemKey);
        return ctx.send({ success: true, created: result.created });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "STORY_NOT_FOUND") return ctx.notFound("استوری یافت نشد.");
        if (code === "ITEM_NOT_FOUND") return ctx.badRequest("این آیتم متعلق به استوری نیست.");
        strapi.log.error("Error marking story item seen", {
          userId: pluginUserId,
          storyId,
          itemKey,
          error: (error as Error)?.message,
        });
        return ctx.internalServerError("خطا در ثبت مشاهده. دوباره تلاش کنید.");
      }
    },

    /**
     * GET /api/story-seens/mine
     * Returns an array of story IDs the authenticated user has already seen.
     */
    async getMine(ctx: any) {
      const pluginUserId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!pluginUserId) return;

      try {
        const storySeenService = strapi.service("api::story-seen.story-seen") as {
          getSeenStoryIds: (userId: number) => Promise<number[]>;
        };
        const ids = await storySeenService.getSeenStoryIds(pluginUserId);
        return ctx.send({ data: ids });
      } catch (error) {
        strapi.log.error("Error fetching seen story ids", {
          userId: pluginUserId,
          error: (error as Error)?.message,
        });
        return ctx.internalServerError("خطا در دریافت استوری‌های مشاهده‌شده. دوباره تلاش کنید.");
      }
    },

    /** GET /api/story-seens/mine-items */
    async getMineItems(ctx: any) {
      const pluginUserId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!pluginUserId) return;
      try {
        const service = strapi.service("api::story-seen.story-seen") as {
          getSeenItems: (userId: number) => Promise<Array<{ storyId: number; itemKeys: string[] }>>;
        };
        return ctx.send({ data: await service.getSeenItems(pluginUserId) });
      } catch (error) {
        strapi.log.error("Error fetching seen story items", {
          userId: pluginUserId,
          error: (error as Error)?.message,
        });
        return ctx.internalServerError("خطا در دریافت استوری‌های مشاهده‌شده. دوباره تلاش کنید.");
      }
    },
  })
);
