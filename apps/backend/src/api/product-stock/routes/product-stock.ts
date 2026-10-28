import { catalogEditRoutes } from "../../../utils/catalogEditRoutes";
/**
 * product-stock router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter("api::product-stock.product-stock", { config: catalogEditRoutes("api::product-stock.product-stock", "stock") });
