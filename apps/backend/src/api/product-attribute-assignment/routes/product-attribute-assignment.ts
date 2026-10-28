// @ts-nocheck
import { catalogEditRoutes } from "../../../utils/catalogEditRoutes";
import { factories } from "@strapi/strapi";
import { publicProductVisibilityRoutes } from "../../../utils/publicProductVisibilityRoutes";

// Public readers only see entries whose product is public (drafts, scheduled
// and trashed products stay hidden); staff are unaffected.
export default factories.createCoreRouter("api::product-attribute-assignment.product-attribute-assignment", {
  config: catalogEditRoutes("api::product-attribute-assignment.product-attribute-assignment", "assignment", publicProductVisibilityRoutes({ mode: "owner", uid: "api::product-attribute-assignment.product-attribute-assignment" })),
});
