// @ts-nocheck
import { catalogEditRoutes } from "../../../utils/catalogEditRoutes";
import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::product-attribute-term.product-attribute-term", { config: catalogEditRoutes("api::product-attribute-term.product-attribute-term", "term") });
