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
  ],
};
