/**
 * Route-config regression test for the live-gateway test-* endpoints.
 *
 * These routes call out to real Mellat/SnappPay credentials. They were previously
 * `auth: false` (fully public, reachable by anyone with no token at all). This pins
 * them to authenticated + superadmin-only, mirroring the settings hero-slider pattern.
 */

import routesConfig from "../routes/custom-router";
import { ROLE_NAMES } from "../../../utils/roles";

describe("payment-gateway test-* routes", () => {
  const testRoutes = routesConfig.routes.filter((route) =>
    String(route.path).startsWith("/payment-gateway/test-"),
  );

  it("covers the three Mellat test endpoints", () => {
    expect(testRoutes).toHaveLength(3);
    expect(testRoutes.map((route) => route.path).sort()).toEqual([
      "/payment-gateway/test-mellat",
      "/payment-gateway/test-mellat-v2",
      "/payment-gateway/test-mellat-v3",
    ]);
  });

  it("requires authentication and a superadmin-only policy on every test endpoint", () => {
    testRoutes.forEach((route) => {
      expect(route.config.auth).toEqual({ scope: [] });
      expect(route.config.policies).toEqual([
        {
          name: "global::role-based",
          config: {
            roles: [ROLE_NAMES.SUPERADMIN],
          },
        },
      ]);
    });
  });

  it("leaves the public availability/eligibility routes untouched", () => {
    const available = routesConfig.routes.find((route) => route.path === "/payment-gateway/available");
    const eligible = routesConfig.routes.find((route) => route.path === "/payment-gateway/snapp-eligible");

    expect(available?.config.auth).toEqual({ scope: [] });
    expect(eligible?.config.auth).toEqual({ scope: [] });
  });
});
