// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

export default factories.createCoreController(
  "api::product-variation-color.product-variation-color",
  ({ strapi }) => ({
    async create(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, ["Title", "ColorCode"]))) return;
      return super.create(ctx);
    },
    async update(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, ["Title", "ColorCode"]))) return;
      return super.update(ctx);
    },
  }),
);
