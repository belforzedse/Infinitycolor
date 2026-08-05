// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

const OPERATIONAL_FIELDS = [
  "Type",
  "Amount",
  "LimitAmount",
  "StartDate",
  "EndDate",
  "IsActive",
  "product_variations",
  "product_categories",
  "removedAt",
] as const;

export default factories.createCoreController(
  "api::general-discount.general-discount",
  ({ strapi }) => ({
    async create(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_FIELDS))) return;
      return super.create(ctx);
    },
    async update(ctx) {
      if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_FIELDS))) return;
      return super.update(ctx);
    },
  }),
);
