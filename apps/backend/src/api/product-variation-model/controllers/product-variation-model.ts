// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

export default factories.createCoreController(
  "api::product-variation-model.product-variation-model",
  ({ strapi }) => ({
    async create(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, ["Title"]))) return;
      return super.create(ctx);
    },
    async update(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, ["Title"]))) return;
      return super.update(ctx);
    },
  }),
);
