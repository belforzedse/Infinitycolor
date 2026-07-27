/**
 * Custom router for payment gateway APIs
 */

import { ROLE_NAMES } from "../../../utils/roles";

const superadminOnlyPolicy = [
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
