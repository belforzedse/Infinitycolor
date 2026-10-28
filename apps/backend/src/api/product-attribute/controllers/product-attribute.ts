// @ts-nocheck
import { factories } from "@strapi/strapi";
import { rejectCatalogInverseRelations } from "../../../utils/catalogOwnership";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

const CREATE_FIELDS = [
  "Title",
  "Slug",
  "Scope",
  "Type",
  "LegacyProjection",
  "Position",
  "owner_product",
] as const;
const UPDATE_FIELDS = CREATE_FIELDS.filter((field) => field !== "owner_product");

export default factories.createCoreController(
  "api::product-attribute.product-attribute",
  ({ strapi }) => ({
    async create(ctx) {
      rejectCatalogInverseRelations("api::product-attribute.product-attribute", ctx.request?.body?.data || {});
      if (!(await enforceOperationalDataFields(ctx, strapi, CREATE_FIELDS))) return;
      return super.create(ctx);
    },
    async update(ctx) {
      rejectCatalogInverseRelations("api::product-attribute.product-attribute", ctx.request?.body?.data || {});
      if (!(await enforceOperationalDataFields(ctx, strapi, UPDATE_FIELDS))) return;
      return super.update(ctx);
    },
  }),
);
