const adminPolicy = [
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
      path: "/sp/local-users",
      handler: "local-user.createUser",
      config: {
        auth: { scope: [] },
        policies: adminPolicy,
      },
    },
    {
      method: "PUT",
      path: "/sp/local-users/:id",
      handler: "local-user.updateUser",
      config: {
        auth: { scope: [] },
        policies: adminPolicy,
      },
    },
  ],
};
