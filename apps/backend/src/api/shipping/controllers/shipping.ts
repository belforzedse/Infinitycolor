// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

const OPERATIONAL_FIELDS = [
  "Title",
  "Code",
  "Description",
  "SortOrder",
  "EstimatedDeliveryText",
  "Icon",
  "Rules",
  "Price",
  "removedAt",
  "IsActive",
] as const;

export default factories.createCoreController("api::shipping.shipping", ({ strapi }) => ({
  async create(ctx) {
    if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_FIELDS))) return;
    return super.create(ctx);
  },
  async update(ctx) {
    if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_FIELDS))) return;
    return super.update(ctx);
  },
}));
