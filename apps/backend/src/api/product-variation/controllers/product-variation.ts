// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";
import {
  buildAttributeSignature,
  loadProductVariationsWithSignatures,
} from "../../product/services/variation-combinations";
import { isTrustedWordPressMigrationRequest } from "../../../utils/migration-context";
import { afterCatalogCommit } from "../../../utils/catalogEdit";
import { clearProductOriginCaches } from "../../../utils/productOriginCache";
import { deleteVariationWithStock } from "../services/variation-removal";

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

/**
 * What a successful write needs to know afterwards; `false` means the request was
 * already answered with an error.
 */
type SignatureOutcome =
  | false
  | { productSlug?: string | null; colorChanged?: boolean };

async function canonicalizeAdminSignature(
  ctx: any,
  strapi: any,
  creating: boolean,
): Promise<SignatureOutcome> {
  if (isTrustedWordPressMigrationRequest()) return {};
  const data = ctx.request?.body?.data;
  if (!data || typeof data !== "object") return {};
  const relationFields = [
    "product_variation_color", "product_variation_size", "product_variation_model",
    "selected_attribute_terms",
  ];
  if (!creating && !relationFields.some((field) => Object.prototype.hasOwnProperty.call(data, field))) {
    return {};
  }

  let existing: any = {};
  if (!creating) {
    existing = await strapi.entityService.findOne(
      "api::product-variation.product-variation",
      Number(ctx.params.id),
      {
        fields: ["id"],
        populate: {
          product: { fields: ["id", "Slug"] },
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
  const signature = buildAttributeSignature(tokens);
  data.AttributeSignature = signature;

  // Generation skips signatures a product already has, but a hand edit bypassed
  // that and could leave two identical variations the PDP cannot tell apart.
  const productId = relationId(creating ? data.product : existing.product);
  if (signature && productId) {
    const selfId = creating ? null : Number(ctx.params.id);
    const siblings = await loadProductVariationsWithSignatures(strapi, productId);
    const duplicate = siblings.find(
      (sibling) => sibling.id !== selfId && sibling.signature === signature,
    );
    if (duplicate) {
      ctx.conflict("این محصول از قبل تنوعی با همین رنگ و ویژگی‌ها دارد", {
        data: { errorCode: "VARIATION_SIGNATURE_EXISTS", variationId: duplicate.id },
      });
      return false;
    }
  }

  const colorChanged =
    !creating &&
    Object.prototype.hasOwnProperty.call(data, "product_variation_color") &&
    relationId(data.product_variation_color) !== relationId(existing.product_variation_color);

  return { productSlug: existing.product?.Slug ?? null, colorChanged };
}

export default factories.createCoreController(
  "api::product-variation.product-variation",
  ({ strapi }) => ({
    async create(ctx) {
      if ("product_stock" in (ctx.request?.body?.data || {})) return ctx.badRequest("Use the product stock operation");
      if (!(await enforceOperationalDataFields(ctx, strapi, CREATE_FIELDS))) return;
      if (!(await canonicalizeAdminSignature(ctx, strapi, true))) return;
      return super.create(ctx);
    },

    async update(ctx) {
      if ("product_stock" in (ctx.request?.body?.data || {})) return ctx.badRequest("Use the product stock operation");
      if (!(await enforceOperationalDataFields(ctx, strapi, UPDATE_FIELDS))) return;
      const outcome = await canonicalizeAdminSignature(ctx, strapi, false);
      if (!outcome) return;
      const response = await super.update(ctx);

      // Variation writes otherwise only refresh the homepage, so a corrected
      // colour stayed wrong on the PDP and listings until every cache expired.
      if (outcome.colorChanged && outcome.productSlug) {
        await afterCatalogCommit(strapi, () => clearProductOriginCaches(strapi, outcome.productSlug!, {
          availabilityCrossed: true,
          logPrefix: "variation-color",
        }));
      }
      return response;
    },

    async delete(ctx) {
      const variationId = Number(ctx.params.id);
      if (!Number.isInteger(variationId) || variationId <= 0) {
        return ctx.badRequest("Variation id must be a positive integer");
      }

      const deleted = await strapi.db.transaction(({ trx }) =>
        deleteVariationWithStock(strapi, variationId, trx),
      );

      if (!deleted) return ctx.notFound("Product variation not found");
      const sanitized = await this.sanitizeOutput(deleted, ctx);
      return this.transformResponse(sanitized);
    },
  }),
);

export { canonicalizeAdminSignature };
