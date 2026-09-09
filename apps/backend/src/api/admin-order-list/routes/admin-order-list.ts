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
    {
      method: "POST",
      path: "/admin/orders-list/reserve-groups/query",
      handler: "admin-order-list.queryReserveGroups",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "order.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/admin/orders-list/reserve-groups/:groupKey",
      handler: "admin-order-list.getReserveGroup",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "order.read" } },
        ],
      },
    },
  ],
};
