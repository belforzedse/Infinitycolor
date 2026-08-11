const capabilityPolicy = (capability: string) => [
  { name: "global::require-capability", config: { capability } },
];

export default {
  routes: [
    {
      method: "GET",
      path: "/audit/events",
      handler: "audit-event.find",
      config: { auth: { scope: [] }, policies: capabilityPolicy("system.audit.read"), middlewares: [] },
    },
    {
      method: "GET",
      path: "/audit/events/:eventId/related",
      handler: "audit-event.related",
      config: { auth: { scope: [] }, policies: capabilityPolicy("system.audit.read"), middlewares: [] },
    },
    {
      method: "GET",
      path: "/audit/events/:eventId",
      handler: "audit-event.findOne",
      config: { auth: { scope: [] }, policies: capabilityPolicy("system.audit.read"), middlewares: [] },
    },
    {
      method: "GET",
      path: "/audit/summary",
      handler: "audit-event.summary",
      config: { auth: { scope: [] }, policies: capabilityPolicy("system.audit.read"), middlewares: [] },
    },
    {
      method: "GET",
      path: "/audit/filter-options",
      handler: "audit-event.filterOptions",
      config: { auth: { scope: [] }, policies: capabilityPolicy("system.audit.read"), middlewares: [] },
    },
    {
      method: "POST",
      path: "/audit/exports",
      handler: "audit-event.exportReport",
      config: { auth: { scope: [] }, policies: capabilityPolicy("system.audit.export"), middlewares: [] },
    },
    {
      method: "POST",
      path: "/internal/audit/events",
      handler: "audit-event.acceptInternal",
      config: { auth: false, policies: [], middlewares: ["api::internal-auth.verify-bridge"] },
    },
  ],
};
