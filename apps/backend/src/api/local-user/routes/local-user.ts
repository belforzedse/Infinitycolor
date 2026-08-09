/**
 * local-user router
 */

import { factories } from "@strapi/strapi";
const adminPolicy = [
  {
    name: "global::require-capability",
    config: {
      capability: "system.users.manage",
    },
  },
];

const adminRouteConfig = {
  auth: { scope: [] },
  policies: adminPolicy,
};

export const __localUserRouteTestUtils = { adminRouteConfig };

export default factories.createCoreRouter("api::local-user.local-user", {
  config: {
    find: adminRouteConfig,
    findOne: adminRouteConfig,
    create: adminRouteConfig,
    update: adminRouteConfig,
    delete: adminRouteConfig,
  },
});
