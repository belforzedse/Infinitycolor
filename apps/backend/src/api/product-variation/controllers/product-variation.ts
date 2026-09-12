// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";
import { buildAttributeSignature } from "../../product/services/variation-combinations";
import { isTrustedWordPressMigrationRequest } from "../../../utils/migration-context";

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

const relationIds = (value: any): number[] => {
  const raw = value?.set ?? value?.connect ?? value?.data ?? value ?? [];
  const rows = Array.isArray(raw) ? raw : [raw];
  return Array.from(new Set(rows
    .map((row) => Number(row?.id ?? row))
    .filter((id) => Number.isSafeInteger(id) && id > 0)));
};

const relationId = (value: any): number | null => relationIds(value)[0] || null;

async function canonicalizeAdminSignature(ctx: any, strapi: any, creating: boolean) {
  if (isTrustedWordPressMigrationRequest()) return true;
  const data = ctx.request?.body?.data;
  if (!data || typeof data !== "object") return true;
  const relationFields = [
    "product_variation_color", "product_variation_size", "product_variation_model",
    "selected_attribute_terms",
  ];
  if (!creating && !relationFields.some((field) => Object.prototype.hasOwnProperty.call(data, field))) {
    return true;
  }

  let existing: any = {};
  if (!creating) {
    existing = await strapi.entityService.findOne(
      "api::product-variation.product-variation",
      Number(ctx.params.id),
      {
        fields: ["id"],
        populate: {
          product_variation_color: { fields: ["id"] },
          product_variation_size: { fields: ["id"] },
          product_variation_model: { fields: ["id"] },
          selected_attribute_terms: { fields: ["id"] },
        },
      },
    );
    if (!existing) {
      ctx.notFound("Product variation not found");
      return false;
    }
  }

  const select = (field: string) => Object.prototype.hasOwnProperty.call(data, field)
    ? data[field]
    : existing[field];
  const termIds = relationIds(select("selected_attribute_terms"));
  const terms = termIds.length > 0
    ? await strapi.entityService.findMany("api::product-attribute-term.product-attribute-term", {
        filters: { id: { $in: termIds } },
        fields: ["id"],
        populate: { product_attribute: { fields: ["id"] } },
        limit: termIds.length,
      })
    : [];
  if ((terms as any[]).length !== termIds.length) {
    ctx.badRequest("Unknown variation attribute term");
    return false;
  }
  const tokens: Array<{ key: string; termId: number }> = [];
  const colorId = relationId(select("product_variation_color"));
  const sizeId = relationId(select("product_variation_size"));
  const modelId = relationId(select("product_variation_model"));
  if (colorId) tokens.push({ key: "color", termId: colorId });
  if (sizeId) tokens.push({ key: "size", termId: sizeId });
  if (modelId) tokens.push({ key: "model", termId: modelId });
  const selectedAttributes = new Set<number>();
  for (const term of terms as any[]) {
    const attributeId = relationId(term.product_attribute);
    if (!attributeId) {
      ctx.badRequest("Variation attribute term has no attribute");
      return false;
    }
    if (selectedAttributes.has(attributeId)) {
      ctx.badRequest("A variation can select only one term from each attribute");
      return false;
    }
    selectedAttributes.add(attributeId);
    tokens.push({ key: `attribute:${attributeId}`, termId: Number(term.id) });
  }
  data.AttributeSignature = buildAttributeSignature(tokens);
  return true;
}

export default factories.createCoreController(
  "api::product-variation.product-variation",
  ({ strapi }) => ({
    async create(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, CREATE_FIELDS))) return;
      if (!(await canonicalizeAdminSignature(ctx, strapi, true))) return;
      return super.create(ctx);
    },

    async update(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, UPDATE_FIELDS))) return;
      if (!(await canonicalizeAdminSignature(ctx, strapi, false))) return;
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

export { canonicalizeAdminSignature };
