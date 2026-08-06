import { STORE_MANAGER_PLUS_ROLES } from "../../../utils/roles";

export default {
  routes: [
    {
      method: "POST",
      path: "/admin/orders-list/query",
      handler: "admin-order-list.query",
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
