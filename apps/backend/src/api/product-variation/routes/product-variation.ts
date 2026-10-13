import { catalogEditRoutes } from "../../../utils/catalogEditRoutes";
/**
 * product-variation router
 */

import { factories } from '@strapi/strapi';
import { publicProductVisibilityRoutes } from "../../../utils/publicProductVisibilityRoutes";

// Public readers only see entries whose product is public (drafts, scheduled
// and trashed products stay hidden); staff are unaffected.
export default factories.createCoreRouter("api::product-variation.product-variation", {
  config: catalogEditRoutes("api::product-variation.product-variation", "variation", publicProductVisibilityRoutes({ mode: "owner", uid: "api::product-variation.product-variation" })),
});
