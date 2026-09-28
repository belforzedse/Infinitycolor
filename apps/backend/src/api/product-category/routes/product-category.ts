/**
 * product-category router
 */

import { factories } from '@strapi/strapi';
import { publicProductVisibilityRoutes } from "../../../utils/publicProductVisibilityRoutes";

// Public readers cannot populate or filter by the product relation, which would
// otherwise list drafts, scheduled and trashed products; staff are unaffected.
export default factories.createCoreRouter("api::product-category.product-category", {
  config: publicProductVisibilityRoutes({ mode: "strip", uid: "api::product-category.product-category", relations: ["products", "product_others"] }),
});
