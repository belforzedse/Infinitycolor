import { ROLE_NAMES, STORE_MANAGER_PLUS_ROLES } from "../../../utils/roles";

const superadminPolicy = [
  {
    name: "global::role-based",
    config: {
      roles: [ROLE_NAMES.SUPERADMIN],
    },
  },
];

const operationalPolicy = [
  {
    name: "global::role-based",
    config: {
      roles: STORE_MANAGER_PLUS_ROLES,
    },
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
