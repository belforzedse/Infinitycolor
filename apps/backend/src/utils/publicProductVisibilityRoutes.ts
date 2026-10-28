import type { PublicProductVisibilityConfig } from "../middlewares/public-product-visibility";

/**
 * Core-router config that runs `global::public-product-visibility` on the read
 * routes of a catalog satellite type (see src/middlewares/public-product-visibility.ts).
 */
export function publicProductVisibilityRoutes(config: PublicProductVisibilityConfig) {
  const middlewares = [{ name: "global::public-product-visibility", config }];
  return {
    find: { middlewares },
    findOne: { middlewares },
  };
}
