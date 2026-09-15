const capabilityPolicy = (capability: string) => [
  {
    name: "global::require-capability",
    config: {
      capability,
    },
  },
];

/**
 * The only routes on this type. There is intentionally no core router: staff
 * phone numbers must never be reachable through the public content API the way
 * `GET /site-settings` exposes `api::settings.settings`.
 */
export default {
  routes: [
    {
      method: "GET",
      path: "/settings/order-alerts",
      handler: "order-alert-setting.get",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: capabilityPolicy("system.settings.manage"),
      },
    },
    {
      method: "PUT",
      path: "/settings/order-alerts",
      handler: "order-alert-setting.update",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: capabilityPolicy("system.settings.manage"),
      },
    },
  ],
};
