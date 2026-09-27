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
    // Product lifecycle (services/product-lifecycle.ts). Move to Trash, restore
    // (always to draft, or the bounded Undo) and permanent deletion are separate
    // routes on separate capabilities; none of their columns is writable through
    // the generic update path. Permanent deletion needs the product in Trash.
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
      method: "POST",
      path: "/products/:id/permanent-delete",
      handler: "product.permanentDelete",
      config: {
        auth: { scope: [] },
        policies: [capabilityPolicy("product.delete")],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/products/lifecycle/bulk",
      handler: "product.bulkLifecycle",
      config: {
        auth: { scope: [] },
        // One route for every lifecycle action: the controller checks the
        // capability of the requested action (publish, schedule, softDelete,
        // restore or delete), the same shape as `/products/:id/publication`.
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/products/trash/empty",
      handler: "product.emptyTrash",
      config: {
        auth: { scope: [] },
        policies: [capabilityPolicy("product.delete")],
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
