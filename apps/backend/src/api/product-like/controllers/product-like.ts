// @ts-nocheck
/**
 * product-like controller
 */

import { factories } from "@strapi/strapi";
import { isProductPubliclyVisible, publicProductFilters } from "../../../utils/productVisibility";
import { resolveCustomerTargetUserId } from "../../../utils/roles";

export default factories.createCoreController(
  "api::product-like.product-like",
  ({ strapi }) => ({
    async toggleFavorite(ctx) {
      try {
        const { productId: rawProductId, isFavorite } = ctx.request.body;
        const productId = Number(rawProductId);

        // Validation
        if (!Number.isSafeInteger(productId) || productId <= 0 ||
            (isFavorite !== undefined && typeof isFavorite !== "boolean")) {
          return ctx.badRequest("Product ID is required");
        }

        const pluginUserId = await resolveCustomerTargetUserId(ctx, strapi);
        if (!pluginUserId) return;

        // Check if product exists. A draft, scheduled or trashed product answers
        // exactly like a missing one, so liking can't probe unpublished ids; an
        // explicit un-like is still allowed so a shopper can clear a stale entry.
        const product = await strapi.entityService.findOne("api::product.product", productId, {
          fields: ["id", "Status", "removedAt"],
        });

        if (!product || (isFavorite !== false && !isProductPubliclyVisible(product))) {
          return ctx.notFound("Product not found");
        }

        const result = await strapi.db.transaction(async ({ trx }) => {
          await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [
            `product-like:${pluginUserId}:${productId}`,
          ]);
          const query = strapi.db.query("api::product-like.product-like");
          const existing = await query.findMany({
            where: { user: pluginUserId, product: productId }, transacting: trx,
          });
          const desired = isFavorite ?? existing.length === 0;
          if (!desired) {
            for (const like of existing) {
              await strapi.entityService.delete("api::product-like.product-like", like.id, { transacting: trx });
            }
          } else if (existing.length === 0) {
            await strapi.entityService.create("api::product-like.product-like", {
              data: { user: pluginUserId, product: productId }, transacting: trx,
            });
          }
          return { success: true, isFavorite: desired };
        });
        return ctx.send(result);
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("An error occurred");
      }
    },

    async getUserLikes(ctx) {
      try {
        const pluginUserId = await resolveCustomerTargetUserId(ctx, strapi);
        if (!pluginUserId) return;

        // Query parameters for pagination
        const { page = 1, pageSize = 25 } = ctx.query;
        const start = (page - 1) * pageSize;
        const limit = parseInt(pageSize);

        // Find all product likes for this user with expanded product data
        const [productLikes, count] = await Promise.all([
          strapi.db.query("api::product-like.product-like").findMany({
            where: {
              user: pluginUserId,
              product: publicProductFilters(),
            },
            populate: {
              product: {
                populate: {
                  CoverImage: true,
                  product_main_category: true,
                  product_tags: true,
                  product_variations: {
                    populate: {
                      product_variation_color: true,
                      product_variation_size: true,
                      product_variation_model: true,
                      product_stock: true,
                    },
                  },
                },
              },
            },
            limit,
            offset: start,
          }),
          strapi.db.query("api::product-like.product-like").count({
            where: {
              user: pluginUserId,
              product: publicProductFilters(),
            },
          }),
        ]);

        return ctx.send({
          data: productLikes,
          meta: {
            pagination: {
              page: parseInt(page),
              pageSize: limit,
              pageCount: Math.ceil(count / limit),
              total: count,
            },
          },
        });
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("An error occurred");
      }
    },
  })
);
