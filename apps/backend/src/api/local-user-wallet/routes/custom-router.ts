const capabilityPolicy = (capability: string) => [
  { name: "global::require-capability", config: { capability } },
];

export default {
  routes: [
    {
      method: "GET",
      path: "/local-user-wallet/me",
      handler: "local-user-wallet.getCurrentUserWallet",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/local-user-wallet/me/transactions",
      handler: "local-user-wallet.getCurrentUserWalletTransactions",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/local-user-wallet/admin/:userId/history",
      handler: "local-user-wallet.adminGetUserWalletHistory",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("wallet.history.read"),
      },
    },
    {
      method: "GET",
      path: "/local-user-wallet/admin/:userId",
      handler: "local-user-wallet.adminGetUserWallet",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("wallet.read"),
      },
    },
    {
      method: "POST",
      path: "/local-user-wallet/admin/adjust",
      handler: "local-user-wallet.adminAdjustWallet",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("wallet.adjust"),
      },
    },
  ],
};
