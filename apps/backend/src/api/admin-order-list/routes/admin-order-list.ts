export default {
  routes: [
    {
      method: "POST",
      path: "/admin/orders-list/query",
      handler: "admin-order-list.query",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "order.read" } },
        ],
      },
    },
  ],
};
