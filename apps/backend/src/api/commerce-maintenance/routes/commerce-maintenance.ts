const superadminOnlyPolicy = [
  {
    name: "global::require-capability",
    config: {
      capability: "system.purge.execute",
    },
  },
];

export default {
  routes: [
    {
      method: "POST",
      path: "/admin/commerce-data/purge",
      handler: "commerce-maintenance.purge",
      config: {
        auth: { scope: [] },
        policies: superadminOnlyPolicy,
      },
    },
  ],
};
