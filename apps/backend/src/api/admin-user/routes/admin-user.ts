const superadminPolicy = [
  {
    name: "global::require-capability",
    config: {
      capability: "system.users.manage",
    },
  },
];

export default {
  routes: [
    {
      method: "POST",
      path: "/admin/users-list/query",
      handler: "admin-user.query",
      config: {
        auth: { scope: [] },
        policies: superadminPolicy,
      },
    },
  ],
};
