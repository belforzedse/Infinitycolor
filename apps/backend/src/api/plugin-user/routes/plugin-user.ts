const superadminPolicy = [
  {
    name: "global::require-capability",
    config: { capability: "system.users.manage" },
  },
];

const operationalPolicy = [
  {
    name: "global::require-capability",
    config: { capability: "wallet.customer.search" },
  },
];

export default {
  routes: [
    {
      method: "POST",
      path: "/sp/plugin-users",
      handler: "plugin-user.createPluginUser",
      config: {
        auth: { scope: [] },
        policies: superadminPolicy,
      },
    },
    {
      method: "GET",
      path: "/sp/customers/search",
      handler: "plugin-user.searchCustomers",
      config: {
        auth: { scope: [] },
        policies: operationalPolicy,
      },
    },
  ],
};
