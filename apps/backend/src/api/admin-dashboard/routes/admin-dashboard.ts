export default {
  routes: [
    {
      method: "POST",
      path: "/admin/dashboard-summary/query",
      handler: "admin-dashboard.query",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "account.self.read" } },
        ],
      },
    },
  ],
};
