const managePolicy = [
  {
    name: "global::require-capability",
    config: { capability: "system.issueReports.manage" },
  },
];

export default {
  routes: [
    {
      method: "POST",
      path: "/issue-reports",
      handler: "issue-report.create",
      config: { auth: { scope: [] }, policies: [], middlewares: [] },
    },
    {
      method: "GET",
      path: "/issue-reports/admin",
      handler: "issue-report.query",
      config: { auth: { scope: [] }, policies: managePolicy, middlewares: [] },
    },
    {
      method: "POST",
      path: "/issue-reports/admin/export",
      handler: "issue-report.exportReport",
      config: { auth: { scope: [] }, policies: managePolicy, middlewares: [] },
    },
    {
      method: "GET",
      path: "/issue-reports/admin/:reportId",
      handler: "issue-report.findOne",
      config: { auth: { scope: [] }, policies: managePolicy, middlewares: [] },
    },
    {
      method: "PATCH",
      path: "/issue-reports/admin/:reportId/status",
      handler: "issue-report.updateStatus",
      config: { auth: { scope: [] }, policies: managePolicy, middlewares: [] },
    },
  ],
};
