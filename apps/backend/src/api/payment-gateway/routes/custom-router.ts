/**
 * Custom router for payment gateway APIs
 */

const superadminOnlyPolicy = [
  {
    name: "global::require-capability",
    config: {
      capability: "system.payments.manage",
    },
  },
];

export default {
  routes: [
    {
      method: "GET",
      path: "/payment-gateway/available",
      handler: "payment-gateway.availableGateways",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "POST",
      path: "/payment-gateway/test-mellat",
      handler: "payment-gateway.testMellat",
      config: {
        auth: { scope: [] },
        policies: superadminOnlyPolicy,
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/payment-gateway/test-mellat-v2",
      handler: "payment-gateway.testMellatV2",
      config: {
        auth: { scope: [] },
        policies: superadminOnlyPolicy,
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/payment-gateway/test-mellat-v3",
      handler: "payment-gateway.testMellatV3",
      config: {
        auth: { scope: [] },
        policies: superadminOnlyPolicy,
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/payment-gateway/snapp-eligible",
      handler: "payment-gateway.snappEligible",
      config: {
        auth: { scope: [] },
      },
    },
  ],
};
