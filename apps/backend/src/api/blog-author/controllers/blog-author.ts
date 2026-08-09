/**
 * blog-author controller
 */

import { factories } from "@strapi/strapi";
import { requireCapability } from "../../../utils/adminAuthorization";

export default factories.createCoreController("api::blog-author.blog-author", ({ strapi }) => ({
  // Create author (Superadmin/Store manager or API token)
  async create(ctx) {
    const { user } = ctx.state;

    // Allow API tokens (no user) or users with proper roles
    if (user) {
      if (!(await requireCapability(ctx, strapi, "content.blog.taxonomy.manage"))) return;
    }

    const { data, meta } = await super.create(ctx);
    return { data, meta };
  },

  // Update author (Superadmin/Store manager or API token)
  async update(ctx) {
    const { user } = ctx.state;

    // Allow API tokens (no user) or users with proper roles
    if (user) {
      if (!(await requireCapability(ctx, strapi, "content.blog.taxonomy.manage"))) return;
    }

    const { data, meta } = await super.update(ctx);
    return { data, meta };
  },

  // Delete author (Superadmin/Store manager only)
  async delete(ctx) {
    const { user } = ctx.state;

    if (!user) return ctx.forbidden("You don't have permission to delete blog authors");
    if (!(await requireCapability(ctx, strapi, "content.blog.taxonomy.manage"))) return;

    const { data, meta } = await super.delete(ctx);
    return { data, meta };
  },
}));
