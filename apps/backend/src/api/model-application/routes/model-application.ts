const managePolicy = [
  {
    name: "global::require-capability",
    config: { capability: "system.modelApplications.manage" },
  },
];

export default {
  routes: [
    {
      method: "POST",
      path: "/model-applications",
      handler: "model-application.create",
      config: { auth: { scope: [] }, policies: [], middlewares: [] },
    },
    {
      method: "GET",
      path: "/model-applications/admin",
      handler: "model-application.query",
      config: { auth: { scope: [] }, policies: managePolicy, middlewares: [] },
    },
    {
      method: "GET",
      path: "/model-applications/admin/:applicationId",
      handler: "model-application.findOne",
      config: { auth: { scope: [] }, policies: managePolicy, middlewares: [] },
    },
    {
      method: "PATCH",
      path: "/model-applications/admin/:applicationId/status",
      handler: "model-application.updateStatus",
      config: { auth: { scope: [] }, policies: managePolicy, middlewares: [] },
    },
  ],
};
