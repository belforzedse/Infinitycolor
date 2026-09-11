// @ts-nocheck
/**
 * blog-comment controller
 */

import { factories } from "@strapi/strapi";
import { hasCapability } from "@repo/auth-core";
import {
  fetchUserWithRole,
  resolveCustomerTargetUserId,
} from "../../../utils/roles";
import { requireCapability, resolveAdminActor } from "../../../utils/adminAuthorization";
import { resolveUserDisplayName } from "../../../utils/blog-helpers";
import { normalizePopulateQuery } from "../../../utils/normalizePopulate";
import {
  buildCacheKey,
  getCacheTtlFromEnv,
  isCacheDebugHeaderEnabled,
  shouldBypassEndpointCache,
  withCache,
  type CacheStatus,
} from "../../../utils/responseCache";

function setCacheHeaderIfEnabled(ctx: any, status: CacheStatus) {
  if (!isCacheDebugHeaderEnabled()) return;
  ctx.set("X-Backend-Cache", status);
}

// `findByPost` renders the public comment thread. Populate depth is fixed
// here rather than trusting client-supplied `ctx.query.populate` (unlike
// `find`, which is admin-gated) — nesting `user_info` is required so a
// commenter's live display name resolves instead of falling back to the
// name that was snapshotted onto the comment at creation time.
const COMMENT_POPULATE = {
  user: { populate: ["user_info"] },
  blog_post: true,
} as const;

export default factories.createCoreController("api::blog-comment.blog-comment", ({ strapi }) => ({
  // Resolve user even when auth middleware is disabled (auth: false)
  async resolveUserFromAuthHeader(ctx) {
    if (ctx.state?.user) return ctx.state.user;

    const authHeader = ctx.request?.header?.authorization || ctx.request?.headers?.authorization;
    const token =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.split(" ")[1]
        : null;

    if (!token) return null;

    try {
      const payload = await strapi.plugin("users-permissions").service("jwt").verify(token);
      const userId = Number(payload?.id || payload?.userId);
      if (!userId || Number.isNaN(userId)) return null;

      const user = await strapi.entityService.findOne("plugin::users-permissions.user", userId, {
        populate: ["role", "user_role", "user_info"],
      });

      if (user) {
        ctx.state.user = user;
      }
      return user;
    } catch {
      return null;
    }
  },

  async hasCommentManagementCapability(user?: any) {
    if (!user?.id) return false;
    const actor = await resolveAdminActor(strapi, user);
    return Boolean(actor && hasCapability(actor.role, "content.blog.comments.manage"));
  },

  // Override find to filter by status for public users
  async find(ctx) {
    if (ctx.query?.populate) {
      ctx.query.populate = normalizePopulateQuery(ctx.query.populate);
    }

    const user = (await this.resolveUserFromAuthHeader(ctx)) || ctx.state.user;
    const hasEditorRole = await this.hasCommentManagementCapability(user);

    // If not Editor+, only show approved comments
    if (!hasEditorRole) {
      ctx.query.filters = {
        ...ctx.query.filters,
        Status: "Approved",
      };
    }

    const { data, meta } = await super.find(ctx);
    return { data, meta };
  },

  // Create comment (authenticated users only)
  async create(ctx) {
    const { user } = ctx.state;

    if (!user) {
      return ctx.unauthorized("Authentication required");
    }
    const targetUserId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!targetUserId) return;

    const { data } = ctx.request.body;
    const populatedUser = await fetchUserWithRole(strapi, targetUserId);
    const commentAuthor = populatedUser || user;
    const resolvedName = resolveUserDisplayName(commentAuthor);

    // Whitelist rather than spread: `replies` is writable on this schema, so
    // a spread would let a commenter reparent other people's comments under
    // their own. Author, date, name, and moderation status stay server-owned.
    const commentData = {
      Content: data?.Content,
      blog_post: data?.blog_post,
      parent_comment: data?.parent_comment ?? null,
      user: targetUserId,
      Date: new Date(),
      Status: "Pending", // All comments start as pending
      Name: resolvedName,
    };

    const comment = await strapi.entityService.create("api::blog-comment.blog-comment", {
      data: commentData,
      populate: ["user", "blog_post"],
    });

    return { data: comment };
  },

  // Update comment (only own comments)
  async update(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;

    if (!user) {
      return ctx.unauthorized("Authentication required");
    }
    const targetUserId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!targetUserId) return;

    // Get existing comment
    const existingComment = await strapi.entityService.findOne(
      "api::blog-comment.blog-comment",
      id,
      {
        populate: ["user"],
      },
    );

    if (!existingComment) {
      return ctx.notFound("Comment not found");
    }

    // Check if user owns the comment or has Editor+ role
    const hasEditorRole = await this.hasCommentManagementCapability(user);

    if (String(existingComment.user.id) !== String(targetUserId) && !hasEditorRole) {
      return ctx.forbidden("You can only edit your own comments");
    }

    const { data } = ctx.request.body;

    // Regular users can only update content, editors can update status
    const updateData = hasEditorRole ? data : { Content: data.Content };

    const comment = await strapi.entityService.update("api::blog-comment.blog-comment", id, {
      data: updateData,
      populate: ["user", "blog_post"],
    });

    return { data: comment };
  },

  // Delete comment (only own comments or Editor+)
  async delete(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;

    if (!user) {
      return ctx.unauthorized("Authentication required");
    }
    const targetUserId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!targetUserId) return;

    // Get existing comment
    const existingComment = await strapi.entityService.findOne(
      "api::blog-comment.blog-comment",
      id,
      {
        populate: ["user"],
      },
    );

    if (!existingComment) {
      return ctx.notFound("Comment not found");
    }

    // Check if user owns the comment or has Editor+ role
    const hasEditorRole = await this.hasCommentManagementCapability(user);

    if (String(existingComment.user.id) !== String(targetUserId) && !hasEditorRole) {
      return ctx.forbidden("You can only delete your own comments");
    }

    const comment = await strapi.entityService.delete("api::blog-comment.blog-comment", id);

    return { data: comment };
  },

  // Get comments for a specific blog post
  async findByPost(ctx) {
    const { postId } = ctx.params;
    const bypassCache = shouldBypassEndpointCache(ctx.request?.headers as Record<string, unknown>);

    if (!bypassCache) {
      const cacheKey = buildCacheKey({
        routeId: "blog-comment.by-post",
        params: { postId },
        query: ctx.query || {},
        locale: String(ctx.query?.locale || ""),
        authSegment: "anon",
      });

      const payload = await withCache(
        {
          key: cacheKey,
          ttlSec: getCacheTtlFromEnv("CACHE_TTL_BLOG_COMMENTS_SEC", 60),
          bypass: false,
          onStatus: (status) => setCacheHeaderIfEnabled(ctx, status),
          shouldCacheValue: (value) => Array.isArray((value as any)?.data),
        },
        async () => {
          const comments = await strapi.entityService.findMany("api::blog-comment.blog-comment", {
            filters: {
              blog_post: postId,
              Status: "Approved",
            },
            sort: { createdAt: "desc" },
            populate: COMMENT_POPULATE,
          });

          return { data: comments };
        },
      );

      return payload;
    }

    const user = (await this.resolveUserFromAuthHeader(ctx)) || ctx.state.user;
    const hasEditorRole = await this.hasCommentManagementCapability(user);

    const filters: any = { blog_post: postId };
    if (!hasEditorRole) {
      filters.Status = "Approved";
    }

    const comments = await strapi.entityService.findMany("api::blog-comment.blog-comment", {
      filters,
      sort: { createdAt: "desc" },
      populate: COMMENT_POPULATE,
    });

    setCacheHeaderIfEnabled(ctx, "BYPASS");
    return { data: comments };
  },

  // Approve comment (Editor+ only)
  async approve(ctx) {
    const { user } = ctx.state;

    if (!(await requireCapability(ctx, strapi, "content.blog.comments.manage"))) return;

    const { id } = ctx.params;

    const comment = await strapi.entityService.update("api::blog-comment.blog-comment", id, {
      data: { Status: "Approved" },
      populate: ["user", "blog_post"],
    });

    return { data: comment };
  },

  // Reject comment (Editor+ only)
  async reject(ctx) {
    const { user } = ctx.state;

    if (!(await requireCapability(ctx, strapi, "content.blog.comments.manage"))) return;

    const { id } = ctx.params;

    const comment = await strapi.entityService.update("api::blog-comment.blog-comment", id, {
      data: { Status: "Rejected" },
      populate: ["user", "blog_post"],
    });

    return { data: comment };
  },
}));
