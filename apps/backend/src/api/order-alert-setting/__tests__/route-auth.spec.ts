import fs from "fs";
import path from "path";

import routeConfig from "../routes/custom-router";

const EXPECTED_POLICIES = [
  {
    name: "global::require-capability",
    config: { capability: "system.settings.manage" },
  },
];

describe("order alert settings route authorization", () => {
  it.each([
    ["GET", "/settings/order-alerts"],
    ["PUT", "/settings/order-alerts"],
  ])("keeps %s %s behind system.settings.manage", (method, routePath) => {
    const route = routeConfig.routes.find(
      (entry) => entry.method === method && entry.path === routePath,
    );
    expect(route).toBeDefined();
    expect(route?.config.auth).toEqual({ scope: [] });
    expect(route?.config.policies).toEqual(EXPECTED_POLICIES);
  });

  it("exposes no unauthenticated route", () => {
    // Staff phone numbers must never become publicly readable the way
    // `GET /site-settings` exposes every `api::settings.settings` attribute.
    for (const route of routeConfig.routes) {
      expect(route.config.auth).not.toBe(false);
      expect(route.config.policies).toEqual(EXPECTED_POLICIES);
    }
  });

  it("ships no core router, which would add public content-API routes", () => {
    const routesDir = path.join(__dirname, "..", "routes");
    expect(fs.readdirSync(routesDir).sort()).toEqual(["custom-router.ts"]);
  });

  it("grants both handler actions, which the capability policy alone cannot do", () => {
    // Strapi U&P 403s any handler missing from the grant before the policy runs,
    // so the route config above is only half the authorization.
    const indexSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "index.ts"),
      "utf8",
    );
    const grantBlock = indexSource.match(
      /"system\.settings\.manage":\s*\{[\s\S]*?\n {2}\},/,
    )?.[0];

    expect(grantBlock).toContain(
      '"api::order-alert-setting": { "order-alert-setting": ["get", "update"] }',
    );
  });
});
