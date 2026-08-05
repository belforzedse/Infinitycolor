import { STORE_MANAGER_PLUS_ROLES } from "../../../utils/roles";

export default {
  routes: [
    {
      method: "POST",
      path: "/products/:id/variation-combinations",
      handler: "product.generateVariationCombinations",
      config: {
        auth: { scope: [] },
        policies: [
          {
            name: "global::role-based",
            config: { roles: STORE_MANAGER_PLUS_ROLES },
          },
        ],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/products/searchwise-feed",
      handler: "product.searchwiseFeed",
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/products/searchwise-feed/items",
      handler: "product.searchwiseFeedItems",
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/products/searchwise-feed/items/:idOrSlug",
      handler: "product.searchwiseFeedItem",
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/products/search",
      handler: "product.search",
      config: {
        auth: false, // Public endpoint, but accepts optional auth for admin access
        policies: [],
        middlewares: [], // No authentication required for product search
        // Note: If an admin user authenticates (via Authorization header),
        // they can see all products including drafts. Regular users only see Active products.
      },
    },
    {
      method: "GET",
      path: "/products/by-slug/:slug",
      handler: "product.findBySlug",
      config: {
        auth: false, // Public endpoint, but accepts optional auth for admin access
        policies: [],
        middlewares: [], // No authentication required for product lookup by slug
        // Note: If an admin user authenticates (via Authorization header),
        // they can see all products including drafts. Regular users only see Active products.
      },
    },
  ],
};
