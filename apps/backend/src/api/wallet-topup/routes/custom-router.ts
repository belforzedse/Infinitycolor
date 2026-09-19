export default {
  routes: [
    {
      method: "GET",
      path: "/wallet/topup-options",
      handler: "wallet-topup.topupOptions",
      config: { auth: { scope: [] } },
    },
    {
      method: "POST",
      path: "/wallet/charge-intent",
      handler: "wallet-topup.chargeIntent",
      config: {
        auth: { scope: [] },
        middlewares: ["api::wallet-topup.charge-intent-throttle"],
      },
    },
    // Providers return by different methods: Mellat posts a form, ZarinPal
    // sends the browser back with a query string. Both are accepted, and
    // neither is ever rate limited — a bank cannot be asked to retry later.
    {
      method: "POST",
      path: "/wallet/payment-callback",
      handler: "wallet-topup.paymentCallback",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/wallet/payment-callback",
      handler: "wallet-topup.paymentCallback",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/wallet/topups",
      handler: "wallet-topup.myTopups",
      config: { auth: { scope: [] } },
    },
    // Declared before `/wallet/topups/:saleOrderId`, which would otherwise
    // match "admin" as a sale order id belonging to nobody.
    {
      method: "GET",
      path: "/wallet/topups/admin/review",
      handler: "wallet-topup.adminReviewTopups",
      config: { auth: { scope: [] } },
    },
    {
      method: "GET",
      path: "/wallet/topups/:saleOrderId",
      handler: "wallet-topup.myTopup",
      config: { auth: { scope: [] } },
    },
  ],
};
