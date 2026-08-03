// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

const CREATE_FIELDS = [
  "Position",
  "IsVisible",
  "IsVariation",
  "product",
  "product_attribute",
  "terms",
] as const;
const UPDATE_FIELDS = ["Position", "IsVisible", "IsVariation", "terms"] as const;

export default factories.createCoreController(
  "api::product-attribute-assignment.product-attribute-assignment",
  ({ strapi }) => ({
    async create(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, CREATE_FIELDS))) return;
      return super.create(ctx);
    },
    async update(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, UPDATE_FIELDS))) return;
      return super.update(ctx);
    },
  }),
);
