import { ROLE_NAMES } from "../../../utils/roles";

const superadminPolicy = [
  {
    name: "global::role-based",
    config: {
      roles: [ROLE_NAMES.SUPERADMIN],
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
