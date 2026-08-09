// @ts-nocheck
/**
 * faq-category controller
 */

import { factories } from "@strapi/strapi";
import { requireCapability } from "../../../utils/adminAuthorization";

export default factories.createCoreController("api::faq-category.faq-category" as any, ({ strapi }) => ({
  // Create category (Superadmin+ or API token)
  async create(ctx) {
    const user = ctx.state.user;

    // Allow API tokens (no user) or users with proper roles
    if (user) {
      if (!(await requireCapability(ctx, strapi, "content.faq.manage"))) return;
    }

    const { data, meta } = await super.create(ctx);
    return { data, meta };
  },

  // Update category (Superadmin+ or API token)
  async update(ctx) {
    const user = ctx.state.user;

    // Allow API tokens (no user) or users with proper roles
    if (user) {
      if (!(await requireCapability(ctx, strapi, "content.faq.manage"))) return;
    }

    const { data, meta } = await super.update(ctx);
    return { data, meta };
  },

  // Delete category (Superadmin+ only)
  async delete(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.forbidden("You don't have permission to delete FAQ categories");
    if (!(await requireCapability(ctx, strapi, "content.faq.manage"))) return;
    
    const { data, meta } = await super.delete(ctx);
    return { data, meta };
  }
}));
