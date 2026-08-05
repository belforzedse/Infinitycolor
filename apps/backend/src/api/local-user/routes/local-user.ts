/**
 * local-user router
 */

import { factories } from "@strapi/strapi";
import { ROLE_NAMES } from "../../../utils/roles";

const adminPolicy = [
  {
    name: "global::role-based",
    config: {
      roles: [ROLE_NAMES.SUPERADMIN],
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
