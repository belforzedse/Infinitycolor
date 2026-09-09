const capabilityPolicy = (capability: string) => ({
  name: "global::require-capability",
  config: { capability },
});

export default {
  routes: [
    {
      method: "POST",
      path: "/products/:id/publication",
      handler: "product.publication",
      config: {
        auth: { scope: [] },
        // Admin role and trusted-importer authorization diverge here, so the
        // controller performs the capability/credential decision after the
        // normal content-API authentication strategy succeeds.
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/products/:id/variation-combinations",
      handler: "product.generateVariationCombinations",
      config: {
        auth: { scope: [] },
        policies: [capabilityPolicy("product.variation.manage")],
        middlewares: [],
      },
    },
    {
      method: "PUT",
      path: "/products/:id/display-date",
      handler: "product.updateDisplayDate",
      config: {
        auth: { scope: [] },
        policies: [capabilityPolicy("product.schedule")],
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
