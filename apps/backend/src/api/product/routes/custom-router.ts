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
    // Re-points one product's variations from a wrongly chosen colour to another,
    // keeping their price, stock and publication. Removing empty duplicate drafts
    // on the way additionally needs product.variation.delete, checked inside.
    {
      method: "POST",
      path: "/products/:id/variation-colors/replace",
      handler: "product.replaceVariationColor",
      config: {
        auth: { scope: [] },
        policies: [capabilityPolicy("product.variation.manage")],
        middlewares: [],
      },
    },
    // Reversible removal to the recycle bin and its undo. Separate routes rather
    // than a `removedAt` write through the generic update path, so each half is
    // gated on its own capability and `removedAt` stays out of the operational
    // free-write allowlist. Permanent deletion is `product.delete` and is not
    // reachable from either of these.
    {
      method: "POST",
      path: "/products/:id/soft-delete",
      handler: "product.softDelete",
      config: {
        auth: { scope: [] },
        policies: [capabilityPolicy("product.softDelete")],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/products/:id/restore",
      handler: "product.restore",
      config: {
        auth: { scope: [] },
        policies: [capabilityPolicy("product.restore")],
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
      method: "POST",
      path: "/products/:id/preview-draft",
      handler: "product.createPreviewDraft",
      config: {
        auth: { scope: [] },
        policies: [capabilityPolicy("product.read")],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/products/preview-draft/:token",
      handler: "product.resolvePreviewDraft",
      config: {
        // The token is the credential (30-minute TTL, 24 random bytes) — the
        // same public-but-bearer-gated shape as /products/by-slug/:slug.
        auth: false,
        policies: [],
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
