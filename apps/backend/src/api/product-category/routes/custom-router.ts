const superadminOnlyPolicy = [
  {
    name: "global::require-capability",
    config: {
      capability: "category.delete",
    },
  },
];

export default {
  routes: [
    {
      method: "POST",
      path: "/product-categories/:id/delete-with-reassign",
      handler: "product-category.deleteWithReassign",
      config: {
        auth: { scope: [] },
        policies: superadminOnlyPolicy,
        middlewares: [{ name: "global::catalog-edit", config: { resource: "category-associations" } }],
      },
    },
  ],
};
