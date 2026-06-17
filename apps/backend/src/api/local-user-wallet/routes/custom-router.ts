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
      method: "GET",
      path: "/local-user-wallet/me",
      handler: "local-user-wallet.getCurrentUserWallet",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/local-user-wallet/admin/:userId",
      handler: "local-user-wallet.adminGetUserWallet",
      config: {
        auth: { scope: [] },
        policies: superadminPolicy,
      },
    },
    {
      method: "POST",
      path: "/local-user-wallet/admin/adjust",
      handler: "local-user-wallet.adminAdjustWallet",
      config: {
        auth: { scope: [] },
        policies: superadminPolicy,
      },
    },
  ],
};
