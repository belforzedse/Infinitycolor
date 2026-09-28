// @ts-nocheck
import { factories } from "@strapi/strapi";
import { publicProductVisibilityRoutes } from "../../../utils/publicProductVisibilityRoutes";

// Public readers cannot populate or filter by the product relation, which would
// otherwise list drafts, scheduled and trashed products; staff are unaffected.
export default factories.createCoreRouter("api::product-attribute.product-attribute", {
  config: publicProductVisibilityRoutes({ mode: "strip", uid: "api::product-attribute.product-attribute", relations: ["owner_product"] }),
});
