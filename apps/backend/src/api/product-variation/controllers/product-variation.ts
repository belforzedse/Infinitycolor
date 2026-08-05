// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

const CREATE_FIELDS = [
  "product",
  "SKU",
  "Price",
  "DiscountPrice",
  "IsPublished",
  "product_variation_color",
  "product_variation_size",
  "product_variation_model",
  "selected_attribute_terms",
] as const;

const UPDATE_FIELDS = CREATE_FIELDS.filter((field) => field !== "product");

export default factories.createCoreController(
  "api::product-variation.product-variation",
  ({ strapi }) => ({
    async create(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, CREATE_FIELDS))) return;
      return super.create(ctx);
    },

    async update(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, UPDATE_FIELDS))) return;
      return super.update(ctx);
    },

    async delete(ctx) {
      const variationId = Number(ctx.params.id);
      if (!Number.isInteger(variationId) || variationId <= 0) {
        return ctx.badRequest("Variation id must be a positive integer");
      }

      const deleted = await strapi.db.transaction(async ({ trx }) => {
        const variation = await strapi.db
          .query("api::product-variation.product-variation")
          .findOne({
            where: { id: variationId },
            populate: ["product_stock"],
            transacting: trx,
          });
        if (!variation) return null;

        const stock = variation.product_stock;
        if (Number(stock?.reservedCount || 0) > 0) {
          const error: any = new Error("Reserved inventory prevents variation deletion");
          error.status = 409;
          throw error;
        }
        if (stock?.id) {
          await strapi.db.query("api::product-stock.product-stock").delete({
            where: { id: stock.id },
            transacting: trx,
          });
        }

        return strapi.db.query("api::product-variation.product-variation").delete({
          where: { id: variationId },
          transacting: trx,
        });
      });

      if (!deleted) return ctx.notFound("Product variation not found");
      const sanitized = await this.sanitizeOutput(deleted, ctx);
      return this.transformResponse(sanitized);
    },
  }),
);
