/**
 * Custom router for admin-activity APIs
 */

const capabilityPolicy = (capability: string) => [
  {
    name: "global::require-capability",
    config: { capability },
  },
];

export default {
  routes: [
    {
      method: "GET",
      path: "/admin-activities/me",
      handler: "admin-activity.findMyActivities",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("system.audit.read"),
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/admin-activities/order/:orderId",
      handler: "admin-activity.findOrderActivities",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.audit.read"),
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/admin-activities/user/:userId",
      handler: "admin-activity.findUserActivities",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("system.audit.read"),
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/admin-activities/product/:productId",
      handler: "admin-activity.findProductActivities",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("system.audit.read"),
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/admin-activities/report",
      handler: "admin-activity.findReport",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("system.audit.read"),
        middlewares: [],
      },
    },
  ],
};
