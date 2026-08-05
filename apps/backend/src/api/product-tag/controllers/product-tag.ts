// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

export default factories.createCoreController("api::product-tag.product-tag", ({ strapi }) => ({
  async create(ctx) {
    if (!(await enforceOperationalDataFields(ctx, strapi, ["Title", "products"]))) return;
    return super.create(ctx);
  },
  async update(ctx) {
    if (!(await enforceOperationalDataFields(ctx, strapi, ["Title", "products"]))) return;
    return super.update(ctx);
  },
}));
