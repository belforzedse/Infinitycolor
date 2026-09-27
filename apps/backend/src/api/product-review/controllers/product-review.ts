// @ts-nocheck
/**
 * product-review controller
 */

import { factories } from "@strapi/strapi";
import { isProductPubliclyVisible } from "../../../utils/productVisibility";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";
import {
  ANONYMOUS_AUTHOR,
  resolveProductReviewAuthorName,
} from "../../../utils/productReviewAuthorName";

// Storefront callers (anonymous and customer alike) lack
// `plugin::users-permissions.user.find`, so `sanitizeOutput` drops the `user`
// relation from every review it serves and the client has nothing left to build
// an author name from. Granting that scope publicly would expose /api/users, so
// the listing resolves the name here instead and ships it as a plain string.
// Selected down to the name fields: the author lookup must never pull the
// credential columns (password, resetPasswordToken, confirmationToken) into
// memory, and only the resolved string ever leaves this module.
const AUTHOR_USER_POPULATE = {
  select: ["id", "username", "phone"],
  populate: { user_info: { select: ["id", "FirstName", "LastName"] } },
} as const;

const AUTHOR_POPULATE = {
  user: AUTHOR_USER_POPULATE,
  product_review_replies: {
    select: ["id"],
    populate: { user: AUTHOR_USER_POPULATE },
  },
} as const;

async function loadAuthorNames(strapi, reviewIds: number[]) {
  const reviewNames = new Map<number, string>();
  const replyNames = new Map<number, string>();
  if (reviewIds.length === 0) return { reviewNames, replyNames };

  const rows = await strapi.db.query("api::product-review.product-review").findMany({
    where: { id: { $in: reviewIds } },
    populate: AUTHOR_POPULATE,
  });

  for (const row of rows || []) {
    reviewNames.set(Number(row.id), resolveProductReviewAuthorName(row.user));
    for (const reply of row.product_review_replies || []) {
      replyNames.set(Number(reply.id), resolveProductReviewAuthorName(reply.user));
    }
  }
  return { reviewNames, replyNames };
}

/**
 * Name-only stand-in for the `user` relation sanitization removed.
 *
 * Storefront builds released before `authorDisplayName` existed read the name out
 * of `user.user_info`, so without this they render every review as "کاربر ناشناس"
 * until a frontend release ships. It carries the single already-public string the
 * review header displays — never the id, phone, email, username or role — and is
 * only ever attached when the relation is absent, so a privileged caller (the
 * admin moderation table, which needs the real phone) keeps the genuine relation.
 */
function nameOnlyUserRelation(displayName: string) {
  return {
    data: {
      id: null,
      attributes: {
        user_info: { data: { attributes: { FirstName: displayName, LastName: null } } },
      },
    },
  };
}

function applyAuthorName(attributes, displayName: string) {
  attributes.authorDisplayName = displayName;
  if (displayName !== ANONYMOUS_AUTHOR && !attributes.user) {
    attributes.user = nameOnlyUserRelation(displayName);
  }
}

function attachAuthorNames(entries, reviewNames, replyNames) {
  for (const entry of entries) {
    const attributes = entry?.attributes;
    if (!attributes) continue;
    applyAuthorName(attributes, reviewNames.get(Number(entry.id)) ?? ANONYMOUS_AUTHOR);

    const replies = attributes.product_review_replies?.data;
    if (!Array.isArray(replies)) continue;
    for (const reply of replies) {
      if (!reply?.attributes) continue;
      applyAuthorName(reply.attributes, replyNames.get(Number(reply.id)) ?? ANONYMOUS_AUTHOR);
    }
  }
}

export default factories.createCoreController(
  "api::product-review.product-review",
  ({ strapi }) => ({
    async update(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, ["Status", "removedAt"]))) return;
      return super.update(ctx);
    },

    // Adds `authorDisplayName` to the sanitized payload. A resolution failure
    // must not blank a product page, so the listing still returns on error.
    async withAuthorNames(payload) {
      const entries = Array.isArray(payload?.data)
        ? payload.data
        : payload?.data
          ? [payload.data]
          : [];
      if (entries.length === 0) return payload;

      try {
        const ids = entries
          .map((entry) => Number(entry?.id))
          .filter((id) => Number.isSafeInteger(id));
        const { reviewNames, replyNames } = await loadAuthorNames(strapi, ids);
        attachAuthorNames(entries, reviewNames, replyNames);
      } catch (error) {
        strapi.log.error("Failed to resolve product review author names", error);
      }
      return payload;
    },

    async find(ctx) {
      if (!ctx.state.auth?.ability?.can("api::product-review.product-review.update")) {
        ctx.query = {
          ...ctx.query,
          filters: {
            $and: [
              ctx.query.filters || {},
              { Status: "Accepted", removedAt: { $null: true } },
            ],
          },
        };
      }
      return this.withAuthorNames(await super.find(ctx));
    },

    async findOne(ctx) {
      if (!ctx.state.auth?.ability?.can("api::product-review.product-review.update")) {
        const review = await strapi.db.query("api::product-review.product-review").findOne({
          where: { id: ctx.params.id, Status: "Accepted", removedAt: null },
          select: ["id"],
        });
        if (!review) return ctx.notFound();
      }
      return this.withAuthorNames(await super.findOne(ctx));
    },

    async submitReview(ctx) {
      try {
        const userId = await resolveCustomerTargetUserId(ctx, strapi);
        if (!userId) return;
        const body = ctx.request.body || {};
        const productId = Number(body.productId);
        const rate = body.rate;
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!Number.isSafeInteger(productId) || productId <= 0 ||
            !Number.isInteger(rate) || rate < 1 || rate > 5 ||
            content.length < 10 || content.length > 4000) {
          return ctx.badRequest("Invalid review fields");
        }

        const product = await strapi.entityService.findOne("api::product.product", productId);
        if (!isProductPubliclyVisible(product)) {
          return ctx.notFound("Product not found");
        }

        return await strapi.db.transaction(async ({ trx }) => {
          await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [
            `product-review:${userId}:${productId}`,
          ]);
          const existingReview = await strapi.db.query("api::product-review.product-review").findOne({
            where: { user: userId, product: productId, removedAt: null },
            orderBy: { id: "asc" },
            transacting: trx,
          });
          // An unchanged retry leaves an already moderated review untouched.
          if (existingReview && existingReview.Rate === rate && existingReview.Content === content) {
            return { ...existingReview, isUpdated: true };
          }
          const data = { Rate: rate, Content: content, Date: new Date(), Status: "Need for Review" };
          if (existingReview) {
            const review = await strapi.entityService.update(
              "api::product-review.product-review", existingReview.id, { data, transacting: trx },
            );
            return { ...review, isUpdated: true };
          }
          const review = await strapi.entityService.create("api::product-review.product-review", {
            data: { ...data, user: userId, product: productId }, transacting: trx,
          });
          return { ...review, isNew: true };
        });
      } catch (error) {
        strapi.log.error("Review submission failed", error);
        return ctx.internalServerError("Unable to submit review");
      }
    },

    // Get all reviews for the current user
    async getUserReviews(ctx) {
      try {
        const userId = await resolveCustomerTargetUserId(ctx, strapi);
        if (!userId) return;

        const { results: reviews, pagination } = await strapi
          .service("api::product-review.product-review")
          .find({
            filters: {
              user: userId,
              removedAt: null,
            },
            populate: ["product"],
            sort: { createdAt: "desc" },
          });

        return { data: reviews, meta: { pagination } };
      } catch (error) {
        return ctx.badRequest("An error occurred while fetching user reviews", {
          error: error.message,
        });
      }
    },
  }),
);
