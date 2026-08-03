import * as Sentry from "@sentry/node";
import bcrypt from "bcryptjs";
import { createClient } from "redis";
import type { Strapi } from "@strapi/strapi";

// Initialize Sentry for error tracking (must be at the very top)
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
});
import override from "./api/auth/documentation/1.0.0/overrides/auth.json";
import localUserOverride from "./api/local-user/documentation/1.0.0/overrides/local-user.json";

import productLifeCycles from "./api/product/lifecycles";
import productVariationLifeCycles from "./api/product-variation/lifecycles";
import { ensureIranLocations } from "./jobs/ensureLocations";
import { startExpireStockReservationsJob } from "./jobs/expireStockReservations";
import { startExpireReserveOrdersJob } from "./jobs/expireReserveOrders";
import { startFlushViewCountersJob } from "./jobs/flushViewCounters";
import { registerAppLifecycles } from "./lifecycles/registerAppLifecycles";
import {
  shouldRunWebBootstrapMaintenance,
  shouldStartInProcessBackgroundJobs,
} from "./utils/processRole";
import {
  assertSnappayRuntimeConfig,
  isSnappayHardenedInitiationEnabled,
} from "./api/payment-gateway/services/snappay-orchestrator";
import { backfillLegacySnappayAttempts } from "./api/payment-gateway/services/snappay-legacy-backfill";
import { ensureSnappayDatabaseInvariants } from "./api/payment-gateway/services/snappay-database";
import { betterAuthJwtStrategy } from "./strategies/better-auth-jwt";

type ControllerActions = Record<string, ReadonlyArray<string> | "*">;
type FullAccessSpec = { mode: "all" };
type GranularSpec = {
  mode?: undefined;
  inherits?: string[];
  grants: Record<string, ControllerActions>;
};
type RolePermissionSpec = FullAccessSpec | GranularSpec;

const READ_ACTIONS = ["find", "findOne"] as const;
const CREATE_UPDATE_ACTIONS = [...READ_ACTIONS, "create", "update"] as const;
const CHILD_CRUD_ACTIONS = [...CREATE_UPDATE_ACTIONS, "delete"] as const;

const FOUNDER_REPORT_ACTIONS = [
  "productSales",
  "productOverview",
  "productTrends",
  "productBreakdown",
  "productPerformance",
  "productInventory",
  "productDetail",
  "productExport",
] as const;

/**
 * Store managers inherit the normal customer surface and receive only the
 * operational commerce actions listed here. Keep this list explicit: using
 * mode=all caused newly-added financial and role-management controllers to be
 * granted automatically.
 */
const STORE_MANAGER_GRANTS: Record<string, ControllerActions> = {
  "api::product": {
    product: [...CREATE_UPDATE_ACTIONS, "search", "generateVariationCombinations"],
  },
  "api::product-category": {
    "product-category": CREATE_UPDATE_ACTIONS,
  },
  "api::product-category-content": {
    "product-category-content": CHILD_CRUD_ACTIONS,
  },
  "api::product-faq": {
    "product-faq": CHILD_CRUD_ACTIONS,
  },
  "api::product-size-helper": {
    "product-size-helper": CHILD_CRUD_ACTIONS,
  },
  "api::product-tag": {
    "product-tag": CREATE_UPDATE_ACTIONS,
  },
  "api::product-variation": {
    "product-variation": CHILD_CRUD_ACTIONS,
  },
  "api::product-variation-color": {
    "product-variation-color": CREATE_UPDATE_ACTIONS,
  },
  "api::product-variation-size": {
    "product-variation-size": CREATE_UPDATE_ACTIONS,
  },
  "api::product-variation-model": {
    "product-variation-model": CREATE_UPDATE_ACTIONS,
  },
  "api::product-attribute": {
    "product-attribute": CREATE_UPDATE_ACTIONS,
  },
  "api::product-attribute-term": {
    "product-attribute-term": CREATE_UPDATE_ACTIONS,
  },
  "api::product-attribute-assignment": {
    "product-attribute-assignment": CHILD_CRUD_ACTIONS,
  },
  "api::product-stock": {
    "product-stock": CREATE_UPDATE_ACTIONS,
  },
  "api::discount": {
    discount: CREATE_UPDATE_ACTIONS,
  },
  "api::general-discount": {
    "general-discount": CREATE_UPDATE_ACTIONS,
  },
  "api::shipping": {
    shipping: CREATE_UPDATE_ACTIONS,
  },
  "api::shipping-city": {
    "shipping-city": READ_ACTIONS,
  },
  "api::shipping-province": {
    "shipping-province": READ_ACTIONS,
  },
  "api::order": {
    order: [
      ...READ_ACTIONS,
      "generateAnipoBarcode",
      "adminAdjustItems",
      "adminUpdateNotes",
      "adminTransition",
      "adminCancel",
      "adminVoidBarcode",
      "decrementStockManual",
    ],
  },
  "api::product-review": {
    "product-review": [...READ_ACTIONS, "update"],
  },
  "api::product-review-reply": {
    "product-review-reply": CHILD_CRUD_ACTIONS,
  },
  "api::plugin-user": {
    "plugin-user": ["searchCustomers"],
  },
  "plugin::upload": {
    "content-api": ["find", "findOne", "upload"],
  },
};

const ROLE_PERMISSION_SPECS: Record<string, RolePermissionSpec> = {
  public: {
    grants: {
      "api::auth": {
        auth: ["welcome", "otp", "login", "loginWithPassword", "resetPassword"],
      },
      "api::product": {
        product: [...READ_ACTIONS, "search"],
      },
      "api::product-category": {
        "product-category": READ_ACTIONS,
      },
      "api::product-category-content": {
        "product-category-content": READ_ACTIONS,
      },
      "api::product-faq": {
        "product-faq": READ_ACTIONS,
      },
      "api::product-size-helper": {
        "product-size-helper": READ_ACTIONS,
      },
      "api::product-tag": {
        "product-tag": READ_ACTIONS,
      },
      "api::product-variation": {
        "product-variation": READ_ACTIONS,
      },
      "api::product-variation-color": {
        "product-variation-color": READ_ACTIONS,
      },
      "api::product-variation-model": {
        "product-variation-model": READ_ACTIONS,
      },
      "api::product-variation-size": {
        "product-variation-size": READ_ACTIONS,
      },
      "api::product-attribute": {
        "product-attribute": READ_ACTIONS,
      },
      "api::product-attribute-term": {
        "product-attribute-term": READ_ACTIONS,
      },
      "api::product-attribute-assignment": {
        "product-attribute-assignment": READ_ACTIONS,
      },
      "api::product-stock": {
        "product-stock": READ_ACTIONS,
      },
      "api::cart-item": {
        "cart-item": READ_ACTIONS,
      },
      "api::product-review": {
        "product-review": READ_ACTIONS,
      },
      "api::product-review-reply": {
        "product-review-reply": READ_ACTIONS,
      },
      "api::product-review-like": {
        "product-review-like": READ_ACTIONS,
      },
      "api::navigation": {
        navigation: ["find"],
      },
      "api::footer": {
        footer: ["find"],
      },
      "api::site-identity": {
        "site-identity": ["find"],
      },
      "api::site-faq": {
        "site-faq": ["find"],
      },
      "api::settings": {
        settings: ["find"],
      },
      "api::shipping": {
        shipping: READ_ACTIONS,
      },
      "api::shipping-city": {
        "shipping-city": READ_ACTIONS,
      },
      "api::shipping-province": {
        "shipping-province": READ_ACTIONS,
      },
      "api::order": {
        order: ["verifyPayment"],
      },
      "api::wallet-topup": {
        "wallet-topup": ["paymentCallback"],
      },
      "api::blog-post": {
        "blog-post": READ_ACTIONS,
      },
      "api::blog-category": {
        "blog-category": READ_ACTIONS,
      },
      "api::blog-tag": {
        "blog-tag": READ_ACTIONS,
      },
      "api::blog-author": {
        "blog-author": READ_ACTIONS,
      },
      "api::blog-comment": {
        "blog-comment": READ_ACTIONS,
      },
      "api::post": {
        post: READ_ACTIONS,
      },
      "api::post-comment": {
        "post-comment": READ_ACTIONS,
      },
      "api::faq-category": {
        "faq-category": READ_ACTIONS,
      },
      "api::faq-question": {
        "faq-question": READ_ACTIONS,
      },
      "api::story": {
        story: [...READ_ACTIONS, "getActive"],
      },
    },
  },
  customer: {
    inherits: ["public"],
    grants: {
      "api::auth": {
        auth: ["self", "registerInfo"],
      },
      "api::cart": {
        cart: [
          "getMyCart",
          "addItem",
          "updateItem",
          "removeItem",
          "checkStock",
          "applyDiscount",
          "mergeGuestCart",
          "checkoutQuote",
          "finalizeToOrder",
          "shippingPreview",
          "shippingOptions",
        ],
      },
      "api::product-like": {
        "product-like": ["toggleFavorite", "getUserLikes"],
      },
      "api::post-like": {
        "post-like": ["toggle", "getUserLikes"],
      },
      "api::post-bookmark": {
        "post-bookmark": ["toggle", "getUserBookmarks"],
      },
      "api::post-comment": {
        "post-comment": ["create", "update", "delete"],
      },
      "api::post-comment-like": {
        "post-comment-like": ["toggle", "getUserLikes"],
      },
      "api::notification": {
        notification: ["listMine", "unreadCount", "markAllRead", "markRead"],
      },
      "api::user-activity": {
        "user-activity": [
          "findUserActivities",
          "findUserActivitiesByUserId",
          "unreadCount",
          "markRead",
          "markAllRead",
        ],
      },
      "api::product-stock": {
        "product-stock": READ_ACTIONS,
      },
      "api::product-review": {
        "product-review": ["submitReview", "getUserReviews"],
      },
      "api::order": {
        order: [
          "getMyOrders",
          "getMyOrderDetail",
          "checkPaymentStatus",
          "reconcilePayment",
          "getActiveReserve",
          "releaseReserve",
        ],
      },
      "api::local-user-address": {
        "local-user-address": [
          "find",
          "findOne",
          "create",
          "update",
          "delete",
          "getMyAddresses",
          "createAddress",
        ],
      },
      "api::local-user-wallet": {
        "local-user-wallet": ["getCurrentUserWallet"],
      },
      "api::local-user-wallet-transaction": {
        "local-user-wallet-transaction": READ_ACTIONS,
      },
      "api::wallet-topup": {
        "wallet-topup": ["chargeIntent"],
      },
      "api::payment-gateway": {
        "payment-gateway": ["snappEligible", "availableGateways"],
      },
      "api::story-seen": {
        "story-seen": ["markSeen", "getMine"],
      },
    },
  },
  editor: {
    inherits: ["customer"],
    grants: {
      "api::blog-post": { "blog-post": CHILD_CRUD_ACTIONS },
      "api::blog-category": { "blog-category": CHILD_CRUD_ACTIONS },
      "api::blog-tag": { "blog-tag": CHILD_CRUD_ACTIONS },
      "api::blog-author": { "blog-author": CHILD_CRUD_ACTIONS },
      "api::blog-comment": { "blog-comment": CHILD_CRUD_ACTIONS },
      "plugin::upload": {
        "content-api": ["find", "findOne", "upload"],
      },
    },
  },
  "store-manager": {
    inherits: ["customer"],
    grants: STORE_MANAGER_GRANTS,
  },
  founder: {
    inherits: ["store-manager"],
    grants: {
      "api::admin-activity": {
        "admin-activity": ["findOrderActivities"],
      },
      "api::report": {
        report: FOUNDER_REPORT_ACTIONS,
      },
    },
  },
  superadmin: { mode: "all" },
};

// Optional escape hatch to allow full Content API access for selected roles.
// WARNING: Enabling this in production will expose write access to the Content API.
const CONTENT_API_ALLOW_ALL = process.env.STRAPI_CONTENT_API_ALLOW_ALL === "true";
if (CONTENT_API_ALLOW_ALL && process.env.NODE_ENV === "production") {
  throw new Error(
    "STRAPI_CONTENT_API_ALLOW_ALL is not supported in production because it overrides the commerce authorization contract",
  );
}
if (CONTENT_API_ALLOW_ALL) {
  const allowRoles = ["public", "customer"];
  allowRoles.forEach((role) => {
    ROLE_PERMISSION_SPECS[role] = { mode: "all" };
  });
}

/**
 * Determines whether a role permission spec grants all permissions.
 *
 * @param spec - The role permission spec to check
 * @returns `true` if the spec's mode equals `"all"`, `false` otherwise
 */
function isFullAccessSpec(spec: RolePermissionSpec): spec is FullAccessSpec {
  return spec.mode === "all";
}

function enableAllActions(tree: Record<string, any>) {
  Object.values(tree).forEach((entry: any) => {
    Object.values(entry.controllers || {}).forEach((controller: any) => {
      Object.values(controller).forEach((action: any) => {
        action.enabled = true;
      });
    });
  });
}

function applyControllerActions(
  tree: Record<string, any>,
  strapi: Strapi,
  typeKey: string,
  controllerName: string,
  actions: ReadonlyArray<string> | "*" = [],
) {
  const typeEntry = tree[typeKey];
  if (!typeEntry?.controllers?.[controllerName]) {
    strapi.log.warn(`Permission template skipped unknown controller: ${typeKey}.${controllerName}`);
    return;
  }

  const controllerEntry = typeEntry.controllers[controllerName];

  if (actions === "*") {
    Object.keys(controllerEntry).forEach((action) => {
      controllerEntry[action].enabled = true;
    });
    return;
  }

  actions.forEach((actionName) => {
    if (!controllerEntry[actionName]) {
      strapi.log.warn(
        `Permission template skipped unknown action: ${typeKey}.${controllerName}.${actionName}`,
      );
      return;
    }
    controllerEntry[actionName].enabled = true;
  });
}

function applySpecRecursive(
  tree: Record<string, any>,
  strapi: Strapi,
  roleType: string,
  visited = new Set<string>(),
) {
  if (visited.has(roleType)) {
    return;
  }
  visited.add(roleType);

  const spec = ROLE_PERMISSION_SPECS[roleType];
  if (!spec) {
    return;
  }

  if (isFullAccessSpec(spec)) {
    enableAllActions(tree);
    return;
  }

  spec.inherits?.forEach((parent) => {
    applySpecRecursive(tree, strapi, parent, visited);
  });

  Object.entries(spec.grants).forEach(([typeKey, controllers]) => {
    Object.entries(controllers).forEach(([controller, actions]) => {
      applyControllerActions(tree, strapi, typeKey, controller, actions);
    });
  });
}

/**
 * Builds the default permissions action tree for the given role type.
 *
 * @param roleType - The role type key (for example: "public", "customer", "store-manager", "editor", "superadmin")
 * @returns A permissions tree object mapping content types and controllers to their action permission flags, configured according to the role's permission spec; if no spec exists for `roleType`, returns a tree with all actions disabled by default.
 */
function getDefaultPermissions(strapi: Strapi, roleType: string): Record<string, any> {
  const usersPermissionsService = strapi.plugin("users-permissions").service("users-permissions");
  const spec = ROLE_PERMISSION_SPECS[roleType];

  if (!spec) {
    return usersPermissionsService.getActions({ defaultEnable: false });
  }

  if (isFullAccessSpec(spec)) {
    return usersPermissionsService.getActions({ defaultEnable: true });
  }

  const tree = usersPermissionsService.getActions({ defaultEnable: false });
  applySpecRecursive(tree, strapi, roleType);
  return tree;
}

export const __rolePermissionTestUtils = {
  getDefaultPermissions,
  ensurePluginRolesAndPermissions: (strapi: Strapi) => ensurePluginRolesAndPermissions(strapi),
};

function collectEnabledPermissionActions(tree: Record<string, any>): string[] {
  const actions: string[] = [];

  Object.entries(tree).forEach(([typeKey, typeEntry]: [string, any]) => {
    Object.entries(typeEntry?.controllers || {}).forEach(
      ([controllerName, controller]: [string, any]) => {
        Object.entries(controller || {}).forEach(([actionName, action]: [string, any]) => {
          if (action?.enabled) {
            actions.push(`${typeKey}.${controllerName}.${actionName}`);
          }
        });
      },
    );
  });

  return actions.sort();
}

async function verifyPersistedRolePermissions(
  strapi: Strapi,
  role: { id: number; name: string },
  expectedTree: Record<string, any>,
) {
  const persisted = await strapi
    .query("plugin::users-permissions.role")
    .findOne({ where: { id: role.id }, populate: ["permissions"] });
  const expected = collectEnabledPermissionActions(expectedTree);
  const actual = ((persisted as any)?.permissions || [])
    .map((permission: any) => permission.action)
    .sort();

  if (
    expected.length !== actual.length ||
    expected.some((action, index) => action !== actual[index])
  ) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((action) => !actualSet.has(action));
    const unexpected = actual.filter((action) => !expectedSet.has(action));
    throw new Error(
      `Persisted permission verification failed for role: ${role.name}; ` +
        `expected=${expected.length} actual=${actual.length} ` +
        `missing=[${missing.join(",")}] unexpected=[${unexpected.join(",")}]`,
    );
  }
}

async function assignRolePermissions(
  strapi: Strapi,
  role: { id: number; name: string; type?: string | null },
) {
  const roleType = role?.type;
  if (!roleType || !ROLE_PERMISSION_SPECS[roleType]) {
    strapi.log.debug(`No permission template configured for role: ${role?.name ?? roleType}`);
    return;
  }

  try {
    const permissions = getDefaultPermissions(strapi, roleType);
    await strapi.plugin("users-permissions").service("role").updateRole(role.id, { permissions });
    await verifyPersistedRolePermissions(strapi, role, permissions);
    strapi.log.info(`✓ Assigned permissions for role: ${role.name}`);
  } catch (error) {
    strapi.log.error(`Could not assign permissions for role: ${role.name}`, {
      error: (error as any)?.message,
    });
    throw error;
  }
}

const COUNTER_ONLY_FIELDS_BY_UID: Record<string, ReadonlySet<string>> = {
  "api::product.product": new Set(["SeenCount"]),
  "api::blog-post.blog-post": new Set(["ViewCount"]),
};

const UPDATE_METADATA_FIELDS = new Set([
  "updatedAt",
  "updated_at",
  "updatedBy",
  "updated_by",
  "publishedAt",
  "published_at",
]);

function isCounterOnlyUpdate(uid: string, payload: Record<string, unknown> | undefined): boolean {
  const allowedFields = COUNTER_ONLY_FIELDS_BY_UID[uid];
  if (!allowedFields || !payload || typeof payload !== "object") {
    return false;
  }

  const meaningfulFields = Object.keys(payload).filter(
    (field) => !UPDATE_METADATA_FIELDS.has(field),
  );
  if (meaningfulFields.length === 0) {
    return false;
  }

  return meaningfulFields.every((field) => allowedFields.has(field));
}

async function ensurePluginRolesAndPermissions(strapi: Strapi) {
  const roles = [
    {
      name: "Superadmin",
      description: "Full access to the system (internal use)",
      type: "superadmin",
    },
    {
      name: "Store manager",
      description: "Operational commerce access without financial or destructive administration",
      type: "store-manager",
    },
    {
      name: "Editor",
      description:
        "Blog content editor - can manage blog posts, categories, tags, authors, and comments",
      type: "editor",
    },
    {
      name: "Founder",
      description:
        "Store manager plus founder-specific operational access, without superadmin-only destructive actions",
      type: "founder",
    },
    { name: "Customer", description: "End customer role", type: "customer" },
  ];

  for (const roleDefinition of roles) {
    const existing = await strapi
      .query("plugin::users-permissions.role")
      .findOne({ where: { name: roleDefinition.name } });
    const role = existing
      ? await strapi.query("plugin::users-permissions.role").update({
          where: { id: existing.id },
          data: {
            description: roleDefinition.description,
            type: roleDefinition.type,
          },
        })
      : await strapi.query("plugin::users-permissions.role").create({
          data: roleDefinition,
        });

    strapi.log.info(
      `${existing ? "✓ Role already exists" : "✓ Created users-permissions role"}: ${roleDefinition.name}`,
      { roleId: role.id },
    );
    await assignRolePermissions(strapi, role as any);
  }

  const publicRole = await strapi
    .query("plugin::users-permissions.role")
    .findOne({ where: { type: "public" } });
  if (!publicRole) {
    throw new Error("Public role not found; permissions could not be synchronized");
  }
  await assignRolePermissions(strapi, publicRole as any);
}

export const RedisClient = createClient({
  url: process.env.REDIS_URL,
  ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
})
  .on("error", (err) => console.log("Redis Client Error", err))
  .connect()
  .then((client) => {
    console.log("Redis connected");
    return client;
  })
  .catch((err) => {
    console.error("Failed to connect to Redis:", err.message);
    // Return a mock client that fails gracefully for development
    throw err;
  });

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }) {
    // Plugins register before the application register hook, so this is appended
    // after the native Users & Permissions content-API strategy.
    strapi.container.get("auth").register("content-api", betterAuthJwtStrategy);
    try {
      const documentationPlugin = strapi.plugin("documentation");
      if (!documentationPlugin) return;

      const overrideService = documentationPlugin.service("override");
      overrideService.registerOverride(override, {});
      overrideService.registerOverride(localUserOverride, {});
    } catch {
      strapi.log.debug("Documentation plugin is disabled; skipping documentation overrides.");
    }
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    const snappayHardenedInitiationEnabled = isSnappayHardenedInitiationEnabled();
    if (snappayHardenedInitiationEnabled) {
      assertSnappayRuntimeConfig();
    }

    const databaseClient = String(
      (strapi.db.connection as any)?.client?.config?.client || "",
    ).toLowerCase();
    if (
      snappayHardenedInitiationEnabled ||
      databaseClient.includes("pg") ||
      databaseClient.includes("postgres")
    ) {
      // These constraints also protect the shared payment-attempt workflow when
      // hardened SnappPay initiation is disabled, so keep them on every
      // PostgreSQL boot. A non-Postgres database still fails closed if hardened
      // initiation is explicitly enabled.
      await ensureSnappayDatabaseInvariants(strapi as any);
    }

    if (snappayHardenedInitiationEnabled) {
      const legacyBackfill = await backfillLegacySnappayAttempts(strapi as any);
      strapi.log.info("Hardened SnappPay runtime configuration validated");
      strapi.log.info("Legacy SnappPay recovery records checked", {
        created: legacyBackfill.created,
        skipped: legacyBackfill.skipped,
      });
    }
    registerAppLifecycles(strapi);
    strapi.db.lifecycles.subscribe(productLifeCycles);
    strapi.db.lifecycles.subscribe(productVariationLifeCycles);

    // Invalidate rest-cache when cached content types change via DB (imports, scripts, entityService)
    const restCache = strapi.plugin("rest-cache");
    if (restCache) {
      const cacheStore = restCache.service("cacheStore") as {
        clearByUid: (uid: string, params?: object, wildcard?: boolean) => Promise<void>;
      };
      const cacheConfig = restCache.service("cacheConfig") as { getUids: () => string[] };
      const uids = cacheConfig.getUids();
      for (const uid of uids) {
        strapi.db.lifecycles.subscribe({
          models: [uid],
          async afterCreate() {
            await cacheStore.clearByUid(uid, {}, true);
          },
          async afterUpdate(event: any) {
            if (isCounterOnlyUpdate(uid, event?.params?.data)) {
              return;
            }
            await cacheStore.clearByUid(uid, {}, true);
          },
          async afterDelete() {
            await cacheStore.clearByUid(uid, {}, true);
          },
        });
      }
    }

    if (!shouldRunWebBootstrapMaintenance()) {
      strapi.log.info("Web bootstrap maintenance skipped for PROCESS_ROLE", {
        role: process.env.PROCESS_ROLE || "web",
      });
      return;
    }

    // Opt-in escape hatch for integration tests: skip the idempotent app-level
    // seeding (Iran locations, role/permission assignment, settings/identity/FAQ,
    // category migrations) and background jobs. These are safe to skip in a fresh
    // test DB and dominate boot time (~minutes of per-role permission writes).
    // Default (unset) behavior is unchanged in dev/staging/production.
    if (process.env.SKIP_BOOTSTRAP_SEED === "true") {
      strapi.log.info("SKIP_BOOTSTRAP_SEED=true — skipping app seeding/jobs (test mode)");
      return;
    }

    ensureIranLocations(strapi).catch((err) => {
      strapi.log.error("Failed to ensure province/city seed", err);
    });
    if (shouldStartInProcessBackgroundJobs()) {
      try {
        startExpireStockReservationsJob(strapi);
      } catch (error) {
        strapi.log.error("Failed to start expire stock reservations job", error);
      }
      try {
        startExpireReserveOrdersJob(strapi);
      } catch (error) {
        strapi.log.error("Failed to start expire reserve orders job", error);
      }
      try {
        startFlushViewCountersJob(strapi);
      } catch (error) {
        strapi.log.error("Failed to start flush view counters job", error);
      }
    } else {
      strapi.log.info("In-process background jobs skipped for this process");
    }
    // Historical compatibility migration. It must remain off unless a separate,
    // reviewed data-migration approval explicitly enables it; central auth never
    // bulk-creates identities from legacy rows.
    (async function migrateLocalUsers() {
      if (process.env.LEGACY_LOCAL_USER_MIGRATION_ENABLED !== "true") {
        strapi.log.info("Legacy local-user bulk migration is disabled");
        return;
      }
      try {
        const localUsers = await strapi.entityService.findMany("api::local-user.local-user", {
          fields: ["id", "Phone", "IsVerified", "Password", "external_id", "external_source"],
        });

        const mapping: Record<number, number> = {};

        for (const lu of localUsers) {
          if (!lu?.Phone) continue;
          const normalizedPhone = String(lu.Phone).trim();

          // If already mapped, record mapping and continue
          const existingLocal = await strapi.entityService.findOne(
            "api::local-user.local-user",
            lu.id,
            { fields: ["strapi_user"] },
          );
          if (existingLocal?.strapi_user) {
            mapping[lu.id] = existingLocal.strapi_user as number;
            continue;
          }

          const legacyProfile = await strapi.db
            .query("api::local-user-info.local-user-info")
            .findOne({
              where: { user: lu.id },
              select: ["FirstName", "LastName"],
            });
          if (
            !legacyProfile ||
            typeof legacyProfile.FirstName !== "string" ||
            !legacyProfile.FirstName.trim() ||
            typeof legacyProfile.LastName !== "string" ||
            !legacyProfile.LastName.trim()
          ) {
            strapi.log.warn("Skipped legacy user migration without required profile names");
            continue;
          }

          // Try to find existing plugin user by phone
          let upUser = await strapi
            .query("plugin::users-permissions.user")
            .findOne({ where: { phone: normalizedPhone } });
          if (!upUser) {
            const email = `${normalizedPhone.replace(/\D/g, "") || "user"}@placeholder.local`;
            // The frozen plugin schema uses a private string, so it will not hash
            // automatically. Preserve a bcrypt value or hash legacy plaintext
            // before this separately approved migration writes a plugin user.
            const createData: any = {
              username: normalizedPhone,
              email,
              phone: normalizedPhone,
              confirmed: !!lu.IsVerified,
              blocked: false,
              IsActive: lu.IsActive !== false,
            };
            if (lu?.Password) {
              const storedPassword = String(lu.Password);
              createData.password = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(storedPassword)
                ? storedPassword
                : await bcrypt.hash(storedPassword, 10);
            }
            if (lu?.external_id) createData.external_id = lu.external_id;
            if (lu?.external_source) createData.external_source = lu.external_source;

            upUser = await strapi.entityService.create("plugin::users-permissions.user", {
              data: createData,
            });
          }

          // Record mapping and update legacy local-user with bridge id
          mapping[lu.id] = upUser.id;
          await strapi.entityService.update("api::local-user.local-user", lu.id, {
            data: { strapi_user: upUser.id },
          });
        }

        // If we have mappings, update all related content that pointed to legacy local-user ids
        const legacyToPlugin = mapping;
        const localIds = Object.keys(legacyToPlugin).map((k) => Number(k));
        if (localIds.length > 0) {
          // helper to remap user FK for a content-type and attribute name
          async function remapRelation(contentType: string, attrName: string) {
            try {
              const items = await strapi.entityService.findMany(contentType, {
                filters: { [attrName]: { $in: localIds } },
                limit: 1000,
              });
              for (const it of items) {
                const oldVal = (it as any)[attrName];
                const newVal = legacyToPlugin[Number(oldVal)];
                if (newVal && Number(oldVal) !== Number(newVal)) {
                  await strapi.entityService.update(contentType, (it as any).id, {
                    data: { [attrName]: newVal },
                  });
                }
              }
            } catch (e) {
              strapi.log.error(`Failed to remap relation ${contentType}.${attrName}`, e);
            }
          }

          // List of content-type/attribute pairs to remap
          const remapList: Array<[string, string]> = [
            ["api::local-user-info.local-user-info", "user"],
            ["api::local-user-wallet.local-user-wallet", "user"],
            ["api::local-user-address.local-user-address", "user"],
            ["api::product-review.product-review", "user"],
            ["api::product-review-reply.product-review-reply", "user"],
            ["api::product-review-like.product-review-like", "user"],
            ["api::product-like.product-like", "user"],
            ["api::wallet-topup.wallet-topup", "user"],
            ["api::order.order", "user"],
            ["api::cart.cart", "user"],
            ["api::contract.contract", "local_user"],
          ];

          for (const [ct, attr] of remapList) {
            await remapRelation(ct, attr);
          }
        }
      } catch (e) {
        strapi.log.error("Failed to migrate local users to plugin users", e);
      }
    })();
    // Authorization is a startup invariant. Await and verify the persisted
    // grant rows so the API never serves with stale Store manager permissions.
    await ensurePluginRolesAndPermissions(strapi);

    // Ensure settings single type exists (idempotent)
    (async function ensureSettings() {
      try {
        const existing = await strapi.db.query("api::settings.settings").findOne();
        if (!existing) {
          await strapi.entityService.create("api::settings.settings", {
            data: {
              filterPublicProductsByTitle: false,
              homeBannerOneImage: "",
              homeBannerOneTitle: "",
              homeBannerOneTitleColor: "",
              homeBannerOneButtonText: "",
              homeBannerOneButtonColor: "",
              homeBannerOneButtonHref: "",
              homeBannerOneSubtitle: "",
              homeBannerOneSubtitleColor: "#ffffff",
              homeBannerOneBackgroundColor: "#f1f5f9",
              homeBannerOneTextSize: 30,
              homeBannerOneFontWeight: "500",
              homeBannerOneTextAlign: "right",
              homeBannerOneContentPosition: "top",
              homeBannerOneImageFit: "cover",
              homeBannerOneImagePosition: "center",
              homeBannerOneDesktopHeight: 220,
              homeBannerOneMobileHeight: 220,
              homeBannerTwoImage: "",
              homeBannerTwoTitle: "",
              homeBannerTwoTitleColor: "",
              homeBannerTwoButtonText: "",
              homeBannerTwoButtonColor: "",
              homeBannerTwoButtonHref: "",
              homeBannerTwoSubtitle: "",
              homeBannerTwoSubtitleColor: "#ffffff",
              homeBannerTwoBackgroundColor: "#f1f5f9",
              homeBannerTwoTextSize: 30,
              homeBannerTwoFontWeight: "500",
              homeBannerTwoTextAlign: "right",
              homeBannerTwoContentPosition: "top",
              homeBannerTwoImageFit: "cover",
              homeBannerTwoImagePosition: "center",
              homeBannerTwoDesktopHeight: 220,
              homeBannerTwoMobileHeight: 220,
              homeFeaturedCategorySlug: "",
              homeFeaturedCategoryBannerImage: "",
              homeFeaturedCategoryTitle: "",
              homeFeaturedCategorySubtitle: "",
              homeFeaturedCategoryCtaText: "",
              homeFeaturedCategoryCtaHref: "",
              homeFeaturedCategoryTextColor: "#111827",
              homeFeaturedCategoryTextSize: 30,
              homeFeaturedCategoryFontWeight: "500",
              homeFeaturedCategoryBannerBackgroundColor: "#f1f5f9",
              homeFeaturedCategoryBannerImageFit: "cover",
              homeFeaturedCategoryBannerImagePosition: "center",
              homeFeaturedCategoryDesktopBannerHeight: 340,
              homeFeaturedCategoryMobileBannerHeight: 260,
              blogDefaultBannerImage: "",
              blogDefaultBannerTitle: "",
              blogDefaultBannerSubtitle: "",
              blogDefaultBannerTitleColor: "",
              blogDefaultBannerSubtitleColor: "",
              blogDefaultBannerLinkText: "",
              blogDefaultBannerLinkColor: "",
              blogCategoryBannerOrder: [],
              homeNewestProductIds: [],
              homeDiscountedProductIds: [],
            },
          });
          strapi.log.info("✓ Created default settings entry");
        }
      } catch (error) {
        strapi.log.error("Failed to ensure settings entry", {
          error: (error as any)?.message,
        });
      }
    })();

    // Ensure site-identity single type exists with the project's existing identity
    // values (idempotent). Seeds ONLY when no record exists, so an administrator's
    // edits are never overwritten on subsequent boots.
    //
    // Seed values are migrated from the previously hardcoded frontend sources:
    //   - siteName/brandDescription -> components/SEO/OrganizationSchema.tsx, config/site.ts
    //   - supportHours/contactNumbers/socialLinks -> constants/footer.ts (FOOTER_DATA)
    //   - stores/addresses -> constants/footer.ts (storeLocations) + components/invoice.tsx
    (async function ensureSiteIdentity() {
      try {
        const existing = await strapi.db.query("api::site-identity.site-identity").findOne();
        if (!existing) {
          await strapi.entityService.create("api::site-identity.site-identity", {
            data: {
              siteName: "فروشگاه پوشاک اینفینیتی",
              brandDescription:
                "پوشاک اینفینیتی با عرضه پوشاک با بهترین قیمت و کیفیت همیشه سعی کرده است تا بهترین ها را برای شما به ارمغان بیاورد!",
              supportHours:
                "شنبه تا پنج شنبه (غیر از روزهای تعطیل) از ساعت9 صبح الی 17 پاسخگوی شما هستیم.",
              hasPhysicalStores: true,
              hasMultipleStores: true,
              stores: [
                {
                  name: "گرگان",
                  address: "گلستان، گرگان، بلوار ناهارخوران، نبش عدالت ۶۸، کد پستی ۴۹۱۶۹۷۳۳۸۱",
                  phones: [{ label: "تلفن فروشگاه", number: "017-325-304-39" }],
                  showInFooter: true,
                  showInAbout: true,
                },
                {
                  name: "گنبد کاووس",
                  address: "گنبد کاووس، ابتدای بلوار دانشجو",
                  showInFooter: true,
                  showInAbout: true,
                },
              ],
              socialLinks: [
                {
                  platform: "instagram",
                  url: "https://www.instagram.com/infinity.color_boutique/",
                  label: "infinity.color_boutique",
                },
                {
                  platform: "telegram",
                  url: "https://t.me/InfinityColorShop",
                  label: "InfinityColorShop",
                },
              ],
              contactNumbers: [
                { label: "تلفن", number: "017-325-304-39", type: "phone" },
                { label: "واتساپ", number: "0901-655-25-30", type: "whatsapp" },
              ],
            },
          });
          strapi.log.info("✓ Created default site-identity entry");
        }
      } catch (error) {
        strapi.log.error("Failed to ensure site-identity entry", {
          error: (error as any)?.message,
        });
      }
    })();

    // Ensure site-faq single type exists, migrating any existing collection-type
    // FAQ data (api::faq-category / api::faq-question) into it once. Guarded by a
    // migrations key so it runs a single time; legacy collection types are left
    // intact (non-destructive) and can be removed later.
    (async function ensureSiteFaq() {
      try {
        const existing = await strapi.db.query("api::site-faq.site-faq").findOne();
        if (existing) {
          return;
        }

        const migrationStore = strapi.store({ type: "core", name: "migrations" });
        const migrationKey = "migrate-legacy-faq-to-site-faq-v1";
        const alreadyRan = await migrationStore.get({ key: migrationKey });

        type LegacyQuestion = {
          Question?: string;
          Answer?: string;
          Order?: number | null;
          IsActive?: boolean | null;
        };
        type LegacyCategory = {
          Title?: string;
          Description?: string | null;
          Order?: number | null;
          faq_questions?: LegacyQuestion[];
        };

        let categories: any[] = [];
        if (!alreadyRan) {
          const legacyCategories = (await strapi.entityService.findMany(
            "api::faq-category.faq-category",
            {
              fields: ["Title", "Description", "Order"],
              populate: {
                faq_questions: {
                  fields: ["Question", "Answer", "Order", "IsActive"],
                },
              },
              limit: -1,
            },
          )) as LegacyCategory[];

          categories = (legacyCategories || [])
            .filter((cat) => cat?.Title)
            .map((cat) => ({
              title: cat.Title as string,
              description: cat.Description ?? undefined,
              order: cat.Order ?? 0,
              items: (cat.faq_questions || [])
                .filter((q) => q?.Question && q?.Answer)
                .map((q) => ({
                  question: q.Question as string,
                  answer: q.Answer as string,
                  order: q.Order ?? 0,
                  isActive: q.IsActive !== false,
                })),
            }));
        }

        await strapi.entityService.create("api::site-faq.site-faq", {
          data: { categories },
        });

        await migrationStore.set({
          key: migrationKey,
          value: {
            executedAt: new Date().toISOString(),
            migratedCategories: categories.length,
          },
        });

        strapi.log.info(
          `✓ Created default site-faq entry (migrated ${categories.length} categories)`,
        );
      } catch (error) {
        strapi.log.error("Failed to ensure site-faq entry", {
          error: (error as any)?.message,
        });
      }
    })();

    // One-time migration: reset all legacy main-category flags to false.
    // This keeps categories non-main by default and avoids implicit auto-selection.
    (async function resetLegacyMainCategoryDefaults() {
      try {
        const migrationStore = strapi.store({ type: "core", name: "migrations" });
        const migrationKey = "reset-main-categories-default-v1";
        const alreadyRan = await migrationStore.get({ key: migrationKey });
        if (alreadyRan) {
          return;
        }

        type ProductCategoryRecord = { id: number; isMainCategory?: boolean | null };
        const categories = (await strapi.entityService.findMany(
          "api::product-category.product-category",
          { fields: ["id", "isMainCategory"], limit: -1 },
        )) as ProductCategoryRecord[];

        let resetCount = 0;
        for (const category of categories) {
          if (!category.isMainCategory) continue;
          await strapi.entityService.update("api::product-category.product-category", category.id, {
            data: { isMainCategory: false },
          });
          resetCount += 1;
        }

        await migrationStore.set({
          key: migrationKey,
          value: {
            executedAt: new Date().toISOString(),
            resetCount,
          },
        });

        strapi.log.info("Product category main-category reset migration completed", {
          total: categories.length,
          resetCount,
        });
      } catch (error) {
        strapi.log.error("Failed to run main-category reset migration", {
          error: (error as any)?.message,
        });
      }
    })();

    // Ongoing safety: child categories cannot remain marked as main.
    (async function enforceMainCategoryHierarchy() {
      try {
        type ProductCategoryRecord = {
          id: number;
          isMainCategory?: boolean | null;
          parent?: { id: number } | null;
        };

        const categories = (await strapi.entityService.findMany(
          "api::product-category.product-category",
          {
            fields: ["id", "isMainCategory"],
            populate: { parent: { fields: ["id"] } },
            limit: -1,
          },
        )) as ProductCategoryRecord[];

        let demotedChildren = 0;
        for (const category of categories) {
          const isChild = Boolean(category.parent?.id);
          const isMainCategory = Boolean(category.isMainCategory);
          if (!isChild || !isMainCategory) continue;

          await strapi.entityService.update("api::product-category.product-category", category.id, {
            data: { isMainCategory: false },
          });
          demotedChildren += 1;
        }

        if (demotedChildren > 0) {
          strapi.log.info("Product category hierarchy enforcement completed", {
            demotedChildren,
          });
        }
      } catch (error) {
        strapi.log.error("Failed to enforce main-category hierarchy", {
          error: (error as any)?.message,
        });
      }
    })();
  },
};
