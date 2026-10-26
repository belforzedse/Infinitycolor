export default {
  routes: [
    {
      method: "GET",
      path: "/products/title-keywords",
      handler: "product-title-suggestions.index",
      config: {
        auth: { scope: [] },
        policies: [
          {
            name: "global::require-capability",
            config: {
              capability: "product.read",
            },
          },
        ],
        middlewares: [],
      },
    },
  ],
};
