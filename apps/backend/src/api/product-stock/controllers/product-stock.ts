// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

export default factories.createCoreController("api::product-stock.product-stock", ({ strapi }) => ({
  async create(ctx) {
    if (!(await enforceOperationalDataFields(ctx, strapi, ["Count", "product_variation"]))) {
      return;
    }
    return super.create(ctx);
  },

  async update(ctx) {
    if (!(await enforceOperationalDataFields(ctx, strapi, ["Count"]))) return;
    return super.update(ctx);
  },
}));
