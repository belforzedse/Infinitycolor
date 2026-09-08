const managementPolicy = [
  {
    name: "global::require-capability",
    config: { capability: "content.categoryEditorial.manage" },
  },
];

export default {
  routes: [
    {
      method: "GET",
      path: "/category-editorial/public/:slug",
      handler: "product-category-content.publicBySlug",
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: "GET",
      path: "/category-editorial/targets",
      handler: "product-category-content.targets",
      config: { auth: { scope: [] }, policies: managementPolicy, middlewares: [] },
    },
    {
      method: "GET",
      path: "/category-editorial/:categoryId",
      handler: "product-category-content.editable",
      config: { auth: { scope: [] }, policies: managementPolicy, middlewares: [] },
    },
    {
      method: "PUT",
      path: "/category-editorial/:categoryId",
      handler: "product-category-content.upsert",
      config: { auth: { scope: [] }, policies: managementPolicy, middlewares: [] },
    },
  ],
};
