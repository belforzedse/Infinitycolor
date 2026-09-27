export default {
  routes: [
    {
      method: "POST",
      path: "/admin/products-list/query",
      handler: "admin-product-list.query",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "product.read" } },
        ],
      },
    },
    {
      method: "POST",
      path: "/admin/products-list/counts",
      handler: "admin-product-list.counts",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "product.read" } },
        ],
      },
    },
  ],
};
