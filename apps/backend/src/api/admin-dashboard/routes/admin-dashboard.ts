import { STORE_MANAGER_PLUS_ROLES } from "../../../utils/roles";

export default {
  routes: [
    {
      method: "POST",
      path: "/admin/dashboard-summary/query",
      handler: "admin-dashboard.query",
      config: {
        auth: { scope: [] },
        policies: [
          {
            name: "global::role-based",
            config: { roles: STORE_MANAGER_PLUS_ROLES },
          },
        ],
      },
    },
  ],
};
