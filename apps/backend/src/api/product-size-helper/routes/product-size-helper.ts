import { catalogEditRoutes } from "../../../utils/catalogEditRoutes";
/**
 * product-size-helper router
 */

import { factories } from '@strapi/strapi';
import { publicProductVisibilityRoutes } from "../../../utils/publicProductVisibilityRoutes";

// Public readers only see entries whose product is public (drafts, scheduled
// and trashed products stay hidden); staff are unaffected.
export default factories.createCoreRouter("api::product-size-helper.product-size-helper", {
  config: catalogEditRoutes("api::product-size-helper.product-size-helper", "size-guide", publicProductVisibilityRoutes({ mode: "owner", uid: "api::product-size-helper.product-size-helper" })),
});
