/**
 * Custom router for event-log APIs
 */

const superadminPolicy = [
  {
    name: "global::require-capability",
    config: { capability: "system.audit.read" },
  },
];

export default {
  routes: [
    {
      method: "GET",
      path: "/event-logs/my-events",
      handler: "event-log.getMyEvents",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/event-logs/order/:orderId",
      handler: "event-log.getOrderEvents",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/event-logs/admin",
      handler: "event-log.getAdminEvents",
      config: {
        auth: { scope: [] },
        policies: superadminPolicy,
      },
    },
  ],
};
