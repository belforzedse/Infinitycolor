/**
 * story controller
 */

import { factories } from "@strapi/strapi";
import { hasCapability } from "@repo/auth-core";
import { requireCapability, resolveAdminActor } from "../../../utils/adminAuthorization";
import { applyStoryCtaMutation, StoryCtaValidationError } from "../lib/story-cta";

type StoryMutationData = {
  Title?: string;
  Slug?: string;
  CtaLabel?: unknown;
  CtaUrl?: unknown;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function generateUniqueStorySlug(
  strapi: any,
  title: string,
  excludeId?: number,
): Promise<string> {
  const baseSlug = slugify(title) || "story";
  let candidate = baseSlug;
  let counter = 1;

  while (true) {
    const existing = await strapi.db.query("api::story.story").findOne({
      where: {
        Slug: candidate,
        ...(excludeId ? { id: { $ne: excludeId } } : {}),
      },
      select: ["id"],
    });

    if (!existing) {
      return candidate;
    }

    candidate = `${baseSlug}-${counter}`;
    counter += 1;
  }
}

export default factories.createCoreController(
  "api::story.story",
  ({ strapi }: { strapi: any }) => ({
    async find(ctx: any) {
      const { user } = ctx.state;
      const actor = user?.id ? await resolveAdminActor(strapi, user) : null;
      const hasAdminRole = Boolean(actor && hasCapability(actor.role, "content.stories.manage"));

      if (!hasAdminRole) {
        ctx.query.filters = {
          ...ctx.query.filters,
          IsActive: true,
        };
      }

      return await super.find(ctx);
    },

    async findOne(ctx: any) {
      const { user } = ctx.state;
      const { id } = ctx.params;
      const actor = user?.id ? await resolveAdminActor(strapi, user) : null;
      const hasAdminRole = Boolean(actor && hasCapability(actor.role, "content.stories.manage"));

      const story = await strapi.entityService.findOne("api::story.story", id, {
        populate: { Media: true, Thumbnail: true },
      });

      if (!story) {
        return ctx.notFound("استوری یافت نشد.");
      }

      if (!hasAdminRole && !story.IsActive) {
        return ctx.notFound("استوری یافت نشد.");
      }

      return { data: story };
    },

    async create(ctx: any) {
      if (!(await requireCapability(ctx, strapi, "content.stories.manage"))) return;

      const data = ctx.request?.body?.data as StoryMutationData | undefined;
      if (!data?.Title?.trim()) {
        return ctx.badRequest("عنوان استوری الزامی است.");
      }
      try {
        applyStoryCtaMutation(data);
      } catch (error) {
        if (error instanceof StoryCtaValidationError) return ctx.badRequest(error.message);
        throw error;
      }
      if (!data.Slug) {
        data.Slug = await generateUniqueStorySlug(strapi, data.Title);
      }

      return await super.create(ctx);
    },

    async update(ctx: any) {
      if (!(await requireCapability(ctx, strapi, "content.stories.manage"))) return;

      const storyId = Number(ctx.params?.id);
      const data = ctx.request?.body?.data as StoryMutationData | undefined;
      if (!data) return ctx.badRequest("اطلاعات استوری الزامی است.");
      try {
        applyStoryCtaMutation(data);
      } catch (error) {
        if (error instanceof StoryCtaValidationError) return ctx.badRequest(error.message);
        throw error;
      }
      if (data && !data.Slug && data.Title?.trim()) {
        data.Slug = await generateUniqueStorySlug(strapi, data.Title, storyId);
      }

      return await super.update(ctx);
    },

    async delete(ctx: any) {
      if (!(await requireCapability(ctx, strapi, "content.stories.manage"))) return;
      return await super.delete(ctx);
    },

    /**
     * GET /api/stories/active
     * Returns active stories within their scheduled window, newest first.
     */
    async getActive(ctx: any) {
      try {
        const now = new Date();

        const stories = await strapi.entityService.findMany("api::story.story", {
          filters: {
            IsActive: true,
            $or: [{ StartAt: { $null: true } }, { StartAt: { $lte: now } }],
            $and: [
              {
                $or: [{ EndAt: { $null: true } }, { EndAt: { $gte: now } }],
              },
            ],
          },
          populate: { Media: true, Thumbnail: true },
          sort: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          limit: 50,
        });

        return ctx.send({ data: stories });
      } catch (error) {
        strapi.log.error("Error fetching active stories", { error: (error as Error)?.message });
        return ctx.internalServerError("خطا در دریافت استوری‌ها. دوباره تلاش کنید.");
      }
    },
  }),
);
