/**
 * product-tag router
 */

import { factories } from '@strapi/strapi';
import { publicProductVisibilityRoutes } from "../../../utils/publicProductVisibilityRoutes";

// Public readers cannot populate or filter by the product relation, which would
// otherwise list drafts, scheduled and trashed products; staff are unaffected.
export default factories.createCoreRouter("api::product-tag.product-tag", {
  config: publicProductVisibilityRoutes({ mode: "strip", uid: "api::product-tag.product-tag", relations: ["products"] }),
});
