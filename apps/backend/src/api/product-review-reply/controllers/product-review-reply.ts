// @ts-nocheck
import { factories } from "@strapi/strapi";
import {
  enforceOperationalDataFields,
  isOperationalManagerRequest,
} from "../../../utils/operationalCommerce";

export default factories.createCoreController(
  "api::product-review-reply.product-review-reply",
  ({ strapi }) => ({
    async create(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, ["Content", "product_review"]))) {
        return;
      }
      if (await isOperationalManagerRequest(ctx, strapi)) {
        ctx.request.body.data.user = ctx.state.user.id;
      }
      return super.create(ctx);
    },
    async update(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, ["Content"]))) return;
      return super.update(ctx);
    },
  }),
);
