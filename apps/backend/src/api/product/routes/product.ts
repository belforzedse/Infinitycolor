import { catalogEditRoutes } from "../../../utils/catalogEditRoutes";
/**
 * product router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter("api::product.product", { config: catalogEditRoutes("api::product.product", "product") });
