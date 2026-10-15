// @ts-nocheck
import { factories } from "@strapi/strapi";
import { rejectCatalogInverseRelations } from "../../../utils/catalogOwnership";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

const CREATE_FIELDS = ["Title", "Slug", "ColorCode", "Position", "product_attribute"] as const;
const UPDATE_FIELDS = CREATE_FIELDS.filter((field) => field !== "product_attribute");

export default factories.createCoreController(
  "api::product-attribute-term.product-attribute-term",
  ({ strapi }) => ({
    async create(ctx) {
      rejectCatalogInverseRelations("api::product-attribute-term.product-attribute-term", ctx.request?.body?.data || {});
      if (!(await enforceOperationalDataFields(ctx, strapi, CREATE_FIELDS))) return;
      return super.create(ctx);
    },
    async update(ctx) {
      rejectCatalogInverseRelations("api::product-attribute-term.product-attribute-term", ctx.request?.body?.data || {});
      if (!(await enforceOperationalDataFields(ctx, strapi, UPDATE_FIELDS))) return;
      return super.update(ctx);
    },
  }),
);
