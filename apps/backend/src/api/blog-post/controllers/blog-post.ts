// @ts-nocheck
/**
 * blog-post controller
 */

import { factories } from "@strapi/strapi";
import { hasCapability } from "@repo/auth-core";
import { requireCapability, resolveAdminActor } from "../../../utils/adminAuthorization";
import { validateBlogSlug, generateUniqueBlogSlug } from "../../../utils/slugValidation";
import { enrichBlogPostsWithAuthorNames } from "../../../utils/blog-helpers";
import { normalizePopulateQuery } from "../../../utils/normalizePopulate";
import { buildHomepageBlogCardQuery, projectHomepageBlogCard } from "./homepage-blog-cards";
import { normalizeBlogListPagination } from "./blog-list-pagination";
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

const blogPostController = factories.createCoreController(
  "api::blog-post.blog-post" as any,
  ({ strapi }: { strapi: any }) => ({
    ensureDefaultPopulate(ctx: any, _populate?: any) {
      const defaultPopulate = {
        blog_category: true,
        blog_tags: true,
        blog_author: {
          populate: {
            Avatar: true,
          },
        },
        FeaturedImage: true,
      };
      if (!ctx.query) ctx.query = {};
      // Always ensure blog_author fields (including avatar) are available
      // Deep merge blog_author.populate instead of overwriting
      const userPopulate = ctx.query.populate || {};
      const userAuthorPopulate =
        userPopulate.blog_author && typeof userPopulate.blog_author === "object"
          ? userPopulate.blog_author
          : {};
      const mergedPopulate = {
        ...defaultPopulate,
        ...userPopulate,
        blog_author: {
          ...userAuthorPopulate,
          populate: {
            Avatar: true,
            ...(userAuthorPopulate.populate || {}),
          },
        },
      };
      ctx.query.populate = normalizePopulateQuery(mergedPopulate);
    },

    async resolveUserFromAuthHeader(ctx: any) {
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

    async getOrCreateAuthorForUser(user: any): Promise<any> {
      if (!user) return null;

      // Get the user's actual name from user_info (same as other admin interfaces)
      const firstName = user.user_info?.FirstName ?? "";
      const lastName = user.user_info?.LastName ?? "";
      const fullName = `${firstName} ${lastName}`.trim();

      // Use the actual name, fallback to username if no name
      const authorName = fullName || user.username || user.email || `user-${user.id}`;

      // Try to find an existing blog-author by users_permissions_user relation
      const existing = await strapi.entityService.findMany("api::blog-author.blog-author", {
        filters: {
          users_permissions_user: user.id,
        },
        populate: {
          users_permissions_user: {
            populate: {
              user_info: "*",
            },
          },
        },
        limit: 1,
      });

      if (existing && existing.length > 0) {
        const existingAuthor = existing[0];
        // Update the Name if it's different from the user's actual name
        if (fullName && existingAuthor.Name !== fullName) {
          await strapi.entityService.update("api::blog-author.blog-author", existingAuthor.id, {
            data: {
              Name: fullName,
              Email: user.email,
            } as any,
          });
          existingAuthor.Name = fullName;
        }

        return existingAuthor;
      }

      // Create a new author entry with proper users_permissions_user relation
      const newAuthor = await strapi.entityService.create("api::blog-author.blog-author", {
        data: {
          Name: authorName,
          Email: user.email,
          users_permissions_user: user.id, // Link to users-permissions user, not local_user
        },
        populate: {
          users_permissions_user: {
            populate: {
              user_info: "*",
            },
          },
        },
      });

      return newAuthor;
    },

    async hasBlogReadCapability(user?: any): Promise<boolean> {
      if (!user?.id) return false;
      const actor = await resolveAdminActor(strapi, user);
      return Boolean(actor && hasCapability(actor.role, "content.blog.read"));
    },

    // Public, bounded contract for the storefront homepage carousel. Keep this
    // separate from the legacy blog list until that page has server pagination.
    async findHomepage(ctx: any) {
      const results = await strapi.entityService.findMany(
        "api::blog-post.blog-post",
        buildHomepageBlogCardQuery(),
      );
      const cards = Array.isArray(results) ? results.map(projectHomepageBlogCard) : [];

      return (this as any).transformResponse(cards);
    },

    // Override find to filter by status for public users
    async find(ctx: any) {
      (this as any).ensureDefaultPopulate(ctx);

      const user = (await (this as any).resolveUserFromAuthHeader(ctx)) || ctx.state.user;

      const hasEditorRole = await this.hasBlogReadCapability(user);

      // If not Editor+, only show published posts
      if (!hasEditorRole) {
        ctx.query.filters = {
          ...ctx.query.filters,
          Status: "Published",
        };
      }

      const sanitizedQuery = await (this as any).sanitizeQuery(ctx);

      const pagination = normalizeBlogListPagination(sanitizedQuery.pagination);
      const { pagination: _restPagination, ...entityQuery } = sanitizedQuery;

      // Entity Service uses start/limit, not the REST page/pageSize object. The
      // old call passed `pagination` through unchanged, so every nominal 8-card
      // query returned all published articles and their rich-text bodies.
      const results = await strapi.entityService.findMany("api::blog-post.blog-post", {
        ...entityQuery,
        start: pagination.start,
        limit: pagination.limit,
      });

      // Calculate pagination manually since we're using entityService
      const total = await strapi.entityService.count("api::blog-post.blog-post", {
        filters: sanitizedQuery.filters,
      });

      const pageCount = Math.ceil(total / pagination.pageSize);

      const responsePagination = {
        page: pagination.page,
        pageSize: pagination.pageSize,
        pageCount,
        total,
      };

      const enrichedResults = enrichBlogPostsWithAuthorNames(results);

      const response = (await (this as any).transformResponse(enrichedResults, {
        pagination: responsePagination,
      })) as any;

      return response;
    },

    // Override findOne to filter by status for public users
    async findOne(ctx: any) {
      const user = (await (this as any).resolveUserFromAuthHeader(ctx)) || ctx.state.user;
      const { id } = ctx.params;
      (this as any).ensureDefaultPopulate(ctx);

      const hasEditorRole = await this.hasBlogReadCapability(user);

      // Get the post
      const post = await strapi.entityService.findOne("api::blog-post.blog-post", id, {
        populate: ctx.query.populate || [
          "blog_category",
          "blog_tags",
          "blog_author",
          "FeaturedImage",
        ],
      });

      if (!post) {
        return ctx.notFound("Post not found");
      }

      // If not Editor+ and post is not published, deny access
      if (!hasEditorRole && post.Status !== "Published") {
        return ctx.notFound("Post not found");
      }

      // Increment view count for published posts (only for non-admin users)
      if (post.Status === "Published" && !hasEditorRole) {
        const viewService = strapi.service("api::product-view.product-view") as {
          queueBlogPostView: (blogPostId: number) => Promise<void>;
        };
        void viewService.queueBlogPostView(Number(id));
      }

      return { data: post };
    },

    // Create post (Editor+ or API token)
    async create(ctx: any) {
      const { user } = ctx.state;

      // Allow API tokens (no user) or users with proper roles
      if (user) {
        if (!(await requireCapability(ctx, strapi, "content.blog.create"))) return;
      }

      const { data } = ctx.request.body;
      if (user && data?.Status === "Published") {
        if (!(await requireCapability(ctx, strapi, "content.blog.publish"))) return;
      }

      // Validate or generate slug
      if (data.Slug) {
        const slugValidation = await validateBlogSlug(strapi, data.Slug);
        if (!slugValidation.isValid) {
          return ctx.badRequest(`Invalid slug: ${slugValidation.error}`);
        }
      } else if (data.Title) {
        // Generate unique slug from title
        data.Slug = await generateUniqueBlogSlug(strapi, data.Title);
      } else {
        return ctx.badRequest("Title is required to generate slug");
      }

      // Set author automatically if not provided and user exists
      if (!data.blog_author && user) {
        // Fetch user with user_info populated
        const fullUser = await strapi.entityService.findOne(
          "plugin::users-permissions.user",
          user.id,
          {
            populate: {
              user_info: "*",
              role: true,
            },
          },
        );

        if (fullUser) {
          const author = await (this as any).getOrCreateAuthorForUser(fullUser);
          if (author) {
            data.blog_author = author.id;
          }
        }
      }

      // Set published date if status is Published
      if (data.Status === "Published" && !data.PublishedAt) {
        data.PublishedAt = new Date();
      }

      const post = await strapi.entityService.create("api::blog-post.blog-post", {
        data,
        populate: ["blog_category", "blog_tags", "blog_author", "FeaturedImage"],
      });

      return { data: post };
    },

    // Update post (Editor+ or API token)
    async update(ctx: any) {
      const { user } = ctx.state;
      const { id } = ctx.params;

      // Allow API tokens (no user) or users with proper roles
      if (user) {
        if (!(await requireCapability(ctx, strapi, "content.blog.update"))) return;
      }

      const { data } = ctx.request.body;
      if (user && data?.Status === "Published") {
        if (!(await requireCapability(ctx, strapi, "content.blog.publish"))) return;
      }

      // Validate slug if it's being changed
      if (data.Slug) {
        const slugValidation = await validateBlogSlug(strapi, data.Slug, parseInt(id));
        if (!slugValidation.isValid) {
          return ctx.badRequest(`Invalid slug: ${slugValidation.error}`);
        }
      }

      // Set published date if status is changing to Published
      if (data.Status === "Published" && !data.PublishedAt) {
        data.PublishedAt = new Date();
      }

      // Auto-assign author if missing and user exists
      if (!data.blog_author && user) {
        // Fetch user with user_info populated
        const fullUser = await strapi.entityService.findOne(
          "plugin::users-permissions.user",
          user.id,
          {
            populate: {
              user_info: "*",
              role: true,
            },
          },
        );

        if (fullUser) {
          const author = await (this as any).getOrCreateAuthorForUser(fullUser);
          if (author) {
            data.blog_author = author.id;
          }
        }
      }

      const post = await strapi.entityService.update("api::blog-post.blog-post", id, {
        data,
        populate: ["blog_category", "blog_tags", "blog_author", "FeaturedImage"],
      });

      return { data: post };
    },

    // Delete post (Editor+ only)
    async delete(ctx: any) {
      const { user } = ctx.state;

      if (!user) return ctx.forbidden("You don't have permission to delete blog posts");
      if (!(await requireCapability(ctx, strapi, "content.blog.delete"))) return;

      const { id } = ctx.params;
      const post = await strapi.entityService.delete("api::blog-post.blog-post", id);

      return { data: post };
    },

    // Get post by slug
    async findBySlug(ctx: any) {
      const { slug } = ctx.params;
      const bypassCache = shouldBypassEndpointCache(
        ctx.request?.headers as Record<string, unknown>,
      );

      const populate = {
        blog_category: true,
        blog_tags: true,
        blog_author: {
          populate: {
            Avatar: true,
          },
        },
        FeaturedImage: true,
      };

      if (!bypassCache) {
        const cacheKey = buildCacheKey({
          routeId: "blog-post.by-slug",
          params: { slug },
          query: ctx.query || {},
          locale: String(ctx.query?.locale || ""),
          authSegment: "anon",
        });

        const cachedPayload = await withCache(
          {
            key: cacheKey,
            ttlSec: getCacheTtlFromEnv("CACHE_TTL_BLOG_SLUG_SEC", 120),
            bypass: false,
            onStatus: (status) => setCacheHeaderIfEnabled(ctx, status),
            shouldCacheValue: (value) => Boolean((value as any)?.data),
          },
          async () => {
            const posts = await strapi.entityService.findMany("api::blog-post.blog-post", {
              filters: { Slug: slug, Status: "Published" },
              populate,
              limit: 1,
            });

            const post = posts[0];
            if (!post) return null;
            return { data: post };
          },
        );

        if (!cachedPayload?.data) {
          return ctx.notFound("Post not found");
        }

        const viewService = strapi.service("api::product-view.product-view") as {
          queueBlogPostView: (blogPostId: number) => Promise<void>;
        };
        void viewService.queueBlogPostView(Number(cachedPayload.data.id));

        return cachedPayload;
      }

      const user = (await (this as any).resolveUserFromAuthHeader(ctx)) || ctx.state.user;
      const hasEditorRole = await this.hasBlogReadCapability(user);

      const posts = await strapi.entityService.findMany("api::blog-post.blog-post", {
        filters: { Slug: slug },
        populate,
        limit: 1,
      });

      const post = posts[0];

      if (!post) {
        return ctx.notFound("Post not found");
      }

      if (!hasEditorRole && post.Status !== "Published") {
        return ctx.notFound("Post not found");
      }

      if (post.Status === "Published" && !hasEditorRole) {
        const viewService = strapi.service("api::product-view.product-view") as {
          queueBlogPostView: (blogPostId: number) => Promise<void>;
        };
        void viewService.queueBlogPostView(Number(post.id));
      }

      setCacheHeaderIfEnabled(ctx, "BYPASS");
      return { data: post };
    },
  }),
);

export default blogPostController;
