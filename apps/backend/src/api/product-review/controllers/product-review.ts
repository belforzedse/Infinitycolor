// @ts-nocheck
/**
 * product-review controller
 */

import { factories } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

export default factories.createCoreController(
  "api::product-review.product-review",
  ({ strapi }) => ({
    async update(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, ["Status", "removedAt"]))) return;
      return super.update(ctx);
    },

    async find(ctx) {
      if (!ctx.state.auth?.ability?.can("api::product-review.product-review.update")) {
        ctx.query = {
          ...ctx.query,
          filters: { $and: [ctx.query.filters || {}, { Status: "Accepted", removedAt: null }] },
        };
      }
      return super.find(ctx);
    },

    async findOne(ctx) {
      if (!ctx.state.auth?.ability?.can("api::product-review.product-review.update")) {
        const review = await strapi.db.query("api::product-review.product-review").findOne({
          where: { id: ctx.params.id, Status: "Accepted", removedAt: null },
          select: ["id"],
        });
        if (!review) return ctx.notFound();
      }
      return super.findOne(ctx);
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
        if (!product || product.removedAt || product.Status !== "Active") {
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
