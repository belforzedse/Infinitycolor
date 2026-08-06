import { STORE_MANAGER_PLUS_ROLES } from "../../../utils/roles";

export default {
  routes: [
    {
      method: "POST",
      path: "/admin/products-list/query",
      handler: "admin-product-list.query",
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
