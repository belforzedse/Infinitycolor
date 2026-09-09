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
import { startReconcileCartCleanupJob } from "./jobs/reconcileCartCleanup";
import { startExpireReserveOrdersJob } from "./jobs/expireReserveOrders";
import { startFlushViewCountersJob } from "./jobs/flushViewCounters";
import { registerAppLifecycles } from "./lifecycles/registerAppLifecycles";
import { registerSchemaRegressionGuard } from "./bootstrap/schemaRegressionGuard";
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
import { ensurePaymentAttemptDatabaseInvariants } from "./api/payment-attempt/services/payment-attempt-database";
import { betterAuthJwtStrategy } from "./strategies/better-auth-jwt";
import {
  mapLegacyFaqCategories,
  siteFaqHasQuestions,
  type LegacyFaqCategory,
} from "./api/site-faq/lib/legacy-migration";
import {
  ADMIN_ROLE_DEFINITIONS,
  capabilitiesForRole,
  normalizeAdminRole,
  type AdminCapability,
  type AdminRoleId,
} from "@repo/auth-core";
import { ensureAuditEventStorage } from "./audit/storage";
import { ensureCategoryEditorialDatabaseInvariant } from "./api/product-category-content/services/category-editorial-database";
import { ensureIssueReportStorage } from "./api/issue-report/services/issue-report-storage";
import { ensureModelApplicationStorage } from "./api/model-application/services/model-application-storage";

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

const PRODUCT_REPORT_ACTIONS = [
  "productSales",
  "productOverview",
  "productTrends",
  "productBreakdown",
  "productPerformance",
  "productInventory",
  "productDetail",
  "productExport",
] as const;

const PRODUCT_READ_GRANTS: Record<string, ControllerActions> = {
  // Bounded admin catalog list (POST /admin/products-list/query). Same pattern as
  // order.read → admin-order-list.query / queryReserveGroups / getReserveGroup;
  // without this, Seller 1+ pass the product.read capability policy but
  // Strapi U&P still 403s the route.
  "api::admin-product-list": { "admin-product-list": ["query"] },
  "api::product": { product: [...READ_ACTIONS, "search"] },
  "api::product-faq": { "product-faq": READ_ACTIONS },
  "api::product-size-helper": { "product-size-helper": READ_ACTIONS },
  "api::product-tag": { "product-tag": READ_ACTIONS },
  "api::product-variation": { "product-variation": READ_ACTIONS },
  "api::product-variation-color": { "product-variation-color": READ_ACTIONS },
  "api::product-variation-size": { "product-variation-size": READ_ACTIONS },
  "api::product-variation-model": { "product-variation-model": READ_ACTIONS },
  "api::product-attribute": { "product-attribute": READ_ACTIONS },
  "api::product-attribute-term": { "product-attribute-term": READ_ACTIONS },
  "api::product-attribute-assignment": { "product-attribute-assignment": READ_ACTIONS },
  "api::product-stock": { "product-stock": READ_ACTIONS },
};

const BLOG_READ_GRANTS: Record<string, ControllerActions> = {
  "api::blog-post": { "blog-post": READ_ACTIONS },
  "api::blog-category": { "blog-category": READ_ACTIONS },
  "api::blog-tag": { "blog-tag": READ_ACTIONS },
  "api::blog-author": { "blog-author": READ_ACTIONS },
  "api::blog-comment": { "blog-comment": READ_ACTIONS },
};

const CAPABILITY_GRANTS: Partial<Record<AdminCapability, Record<string, ControllerActions>>> = {
  "content.blog.read": BLOG_READ_GRANTS,
  "content.blog.create": {
    "api::blog-post": { "blog-post": ["create"] },
    "plugin::upload": { "content-api": ["find", "findOne", "upload"] },
  },
  "content.blog.update": {
    "api::blog-post": { "blog-post": ["update"] },
    "plugin::upload": { "content-api": ["find", "findOne", "upload"] },
  },
  "content.blog.publish": { "api::blog-post": { "blog-post": ["update"] } },
  "content.blog.delete": { "api::blog-post": { "blog-post": ["delete"] } },
  "content.blog.taxonomy.manage": {
    "api::blog-category": { "blog-category": CHILD_CRUD_ACTIONS },
    "api::blog-tag": { "blog-tag": CHILD_CRUD_ACTIONS },
    "api::blog-author": { "blog-author": CHILD_CRUD_ACTIONS },
  },
  "content.blog.comments.manage": {
    "api::blog-comment": { "blog-comment": [...CHILD_CRUD_ACTIONS, "approve", "reject"] },
    "api::post-comment": { "post-comment": [...CHILD_CRUD_ACTIONS, "approve", "reject"] },
  },
  "content.blog.banners.manage": {
    "api::settings": { settings: ["getBlogBanners", "updateBlogBanners"] },
  },
  "content.stories.manage": {
    "api::story": { story: CHILD_CRUD_ACTIONS },
    "plugin::upload": { "content-api": ["find", "findOne", "upload"] },
  },
  "content.faq.manage": {
    "api::faq-category": { "faq-category": CHILD_CRUD_ACTIONS },
    "api::faq-question": { "faq-question": CHILD_CRUD_ACTIONS },
    "api::site-faq": { "site-faq": ["find", "update"] },
  },
  "content.categoryEditorial.manage": {
    "api::product-category-content": {
      "product-category-content": ["targets", "editable", "upsert"],
    },
    "plugin::upload": { "content-api": ["find", "findOne", "upload"] },
  },
  "product.read": PRODUCT_READ_GRANTS,
  "product.create": { "api::product": { product: ["create"] } },
  "product.update": { "api::product": { product: ["update"] } },
  "product.publish": { "api::product": { product: ["publication"] } },
  "product.schedule": {
    "api::product": { product: ["publication", "updateDisplayDate"] },
  },
  "product.stock.update": {
    "api::product-stock": { "product-stock": CREATE_UPDATE_ACTIONS },
  },
  "product.media.manage": {
    "plugin::upload": { "content-api": ["find", "findOne", "upload"] },
  },
  "product.variation.manage": {
    "api::product": { product: ["generateVariationCombinations"] },
    "api::product-variation": { "product-variation": CREATE_UPDATE_ACTIONS },
    "api::product-variation-color": { "product-variation-color": CREATE_UPDATE_ACTIONS },
    "api::product-variation-size": { "product-variation-size": CREATE_UPDATE_ACTIONS },
    "api::product-variation-model": { "product-variation-model": CREATE_UPDATE_ACTIONS },
    "api::product-attribute": { "product-attribute": CREATE_UPDATE_ACTIONS },
    "api::product-attribute-term": { "product-attribute-term": CREATE_UPDATE_ACTIONS },
    "api::product-attribute-assignment": {
      "product-attribute-assignment": CREATE_UPDATE_ACTIONS,
    },
  },
  "product.size-guide.manage": {
    "api::product-size-helper": { "product-size-helper": CREATE_UPDATE_ACTIONS },
    "api::product-faq": { "product-faq": CREATE_UPDATE_ACTIONS },
    "api::product-tag": { "product-tag": CREATE_UPDATE_ACTIONS },
  },
  "product.variation.delete": {
    "api::product-variation": { "product-variation": ["delete"] },
  },
  "product.size-guide.delete": {
    "api::product-size-helper": { "product-size-helper": ["delete"] },
  },
  "product.delete": { "api::product": { product: ["delete"] } },
  "category.read": { "api::product-category": { "product-category": READ_ACTIONS } },
  "category.create": { "api::product-category": { "product-category": ["create"] } },
  "category.update": { "api::product-category": { "product-category": ["update"] } },
  "category.delete": {
    "api::product-category": {
      "product-category": ["delete", "deleteWithReassign"],
    },
  },
  "order.read": {
    // Same pattern as product.read → admin-product-list.query: the capability
    // policy is not enough on its own. Strapi U&P still 403s any handler that
    // is missing from the grant, which is why Seller 2+ could open /orders
    // but not the reserve-groups board until these actions were listed here.
    "api::admin-order-list": {
      "admin-order-list": ["query", "queryReserveGroups", "getReserveGroup"],
    },
    "api::order": { order: ["findOne"] },
  },
  "order.financial.read": {
    "api::order": { order: ["adminPaymentOperation"] },
  },
  "order.status.update": { "api::order": { order: ["adminTransition"] } },
  "order.notes.update": { "api::order": { order: ["adminUpdateNotes"] } },
  "order.items.adjust": { "api::order": { order: ["adminAdjustItems"] } },
  "order.cancel": { "api::order": { order: ["adminCancel"] } },
  "order.manual.create": {
    "api::order": { order: ["create", "decrementStockManual"] },
    "api::order-item": { "order-item": ["create"] },
    "api::contract": { contract: ["create"] },
    "api::contract-transaction": { "contract-transaction": ["create"] },
  },
  "order.shipping.manage": {
    "api::order": {
      order: ["generateAnipoBarcode", "checkAnipoBarcode", "adminVoidBarcode"],
    },
  },
  "report.product.read": { "api::report": { report: PRODUCT_REPORT_ACTIONS } },
  "report.sales.read": {
    "api::report": {
      report: ["salesBreakdown", "salesBreakdownExport", "overview"],
    },
  },
  "report.finance.read": {
    "api::report": { report: ["liquidity", "gatewayLiquidity"] },
  },
  "report.carts.read": { "api::cart": { cart: ["find"] } },
  "report.traffic.read": {
    "api::report": {
      report: [
        "behaviorOverview",
        "behaviorAcquisition",
        "behaviorConversion",
        "behaviorContent",
        "behaviorAudience",
        "behaviorPerformance",
        "behaviorRealtime",
      ],
    },
  },
  "wallet.customer.search": {
    "api::plugin-user": { "plugin-user": ["searchCustomers"] },
  },
  "wallet.read": {
    "api::local-user-wallet": { "local-user-wallet": ["adminGetUserWallet"] },
  },
  "wallet.history.read": {
    "api::local-user-wallet": { "local-user-wallet": ["adminGetUserWalletHistory"] },
  },
  "wallet.adjust": {
    "api::local-user-wallet": { "local-user-wallet": ["adminAdjustWallet"] },
  },
  // Superadmin-only today (allCapabilities / mode:all). Explicit grants keep the
  // capability→route contract testable and safe if these are ever assigned lower.
  "order.audit.read": {
    "api::admin-activity": { "admin-activity": ["findOrderActivities"] },
  },
  "system.users.manage": {
    "api::admin-user": { "admin-user": ["query"] },
    "api::plugin-user": { "plugin-user": ["createPluginUser"] },
    "api::local-user": { "local-user": ["createUser", "updateUser"] },
  },
  "system.audit.read": {
    "api::audit-event": {
      "audit-event": ["find", "findOne", "related", "summary", "filterOptions"],
    },
    "api::admin-activity": {
      "admin-activity": [
        "findMyActivities",
        "findUserActivities",
        "findProductActivities",
        "findReport",
      ],
    },
    "api::report": { report: ["adminActivity", "adminActivityById"] },
    "api::event-log": { "event-log": ["getAdminEvents"] },
  },
  "system.audit.export": {
    "api::audit-event": { "audit-event": ["exportReport"] },
  },
  "system.settings.manage": {
    "api::settings": { settings: ["find", "update"] },
  },
  "system.customization.manage": {
    "api::settings": {
      settings: ["getHeroSlider", "updateHeroSliderDraft", "publishHeroSliderDraft"],
    },
  },
  "system.purge.execute": {
    "api::commerce-maintenance": { "commerce-maintenance": ["purge"] },
  },
  "system.payments.manage": {
    "api::payment-gateway": {
      "payment-gateway": ["testMellat", "testMellatV2", "testMellatV3"],
    },
  },
  "system.discounts.manage": {
    "api::discount": { discount: CHILD_CRUD_ACTIONS },
    "api::general-discount": { "general-discount": CHILD_CRUD_ACTIONS },
  },
  "system.shipping.manage": {
    "api::shipping": { shipping: CHILD_CRUD_ACTIONS },
    "api::shipping-city": { "shipping-city": CHILD_CRUD_ACTIONS },
    "api::shipping-province": { "shipping-province": CHILD_CRUD_ACTIONS },
  },
  "system.reviews.manage": {
    "api::product-review": { "product-review": CHILD_CRUD_ACTIONS },
    "api::product-review-reply": { "product-review-reply": CHILD_CRUD_ACTIONS },
  },
  "system.issueReports.manage": {
    "api::issue-report": {
      "issue-report": ["query", "findOne", "updateStatus", "exportReport"],
    },
  },
  "system.modelApplications.manage": {
    "api::model-application": {
      "model-application": ["query", "findOne", "updateStatus"],
    },
  },
};

function mergeGrants(
  target: Record<string, ControllerActions>,
  source: Record<string, ControllerActions>,
) {
  for (const [typeKey, controllers] of Object.entries(source)) {
    const targetControllers = (target[typeKey] ||= {});
    for (const [controllerName, actions] of Object.entries(controllers)) {
      const existing = targetControllers[controllerName];
      if (existing === "*" || actions === "*") {
        targetControllers[controllerName] = "*";
      } else {
        targetControllers[controllerName] = [...new Set([...(existing || []), ...actions])];
      }
    }
  }
}

function grantsForAdminRole(role: AdminRoleId): Record<string, ControllerActions> {
  const grants: Record<string, ControllerActions> = {};
  for (const capability of capabilitiesForRole(role)) {
    const mapping = CAPABILITY_GRANTS[capability];
    if (mapping) mergeGrants(grants, mapping);
  }
  return grants;
}

const ROLE_PERMISSION_SPECS: Record<string, RolePermissionSpec> = {
  public: {
    grants: {
      "api::auth": {
        auth: ["welcome", "otp", "login", "loginWithPassword", "resetPassword"],
      },
      "api::issue-report": {
        "issue-report": ["create"],
      },
      "api::model-application": {
        "model-application": ["create"],
      },
      "api::product": {
        product: [...READ_ACTIONS, "search"],
      },
      "api::product-category": {
        "product-category": READ_ACTIONS,
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
      // Deliberately absent from the public role:
      //   api::cart-item     — /cart-items is a default core router, so a public
      //                        find/findOne let anyone enumerate every customer's
      //                        cart lines. Carts are read through /carts/me only.
      //   api::product-stock — raw inventory persistence (Count, reservedCount).
      //                        Storefront availability reaches the client through
      //                        the product / product-variation populate of
      //                        product_stock, which is unaffected by this grant.
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
      // No api::product-stock grant: customers never call /product-stocks (only the
      // staff admin surfaces do), and the storefront gets availability through the
      // product / product-variation populate of product_stock instead.
      "api::product-review": {
        "product-review": ["submitReview", "getUserReviews"],
      },
      // The blog-comment `create` override owns author, date, name, and
      // moderation status, and whitelists the writable fields, so customers
      // can only ever file a Pending comment authored by themselves.
      "api::blog-comment": {
        "blog-comment": ["create"],
      },
      "api::order": {
        order: [
          "getMyOrders",
          "getMyOrderDetail",
          "checkPaymentStatus",
          "reconcilePayment",
          "getActiveReserve",
          "releaseReserve",
          "listMyReserveGroups",
          "getMyReserveGroup",
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
      "api::payment-gateway": {
        "payment-gateway": ["snappEligible", "availableGateways"],
      },
      "api::story-seen": {
        "story-seen": ["markSeen", "getMine"],
      },
    },
  },
  "staff-self": {
    inherits: ["customer"],
    grants: {
      "api::auth": { auth: ["self", "updateSelf", "registerInfo"] },
      "api::admin-dashboard": { "admin-dashboard": ["query"] },
    },
  },
  editor: {
    inherits: ["staff-self"],
    grants: grantsForAdminRole("editor"),
  },
  "seller-1": {
    inherits: ["staff-self"],
    grants: grantsForAdminRole("seller1"),
  },
  "seller-2": {
    inherits: ["staff-self"],
    grants: grantsForAdminRole("seller2"),
  },
  "store-manager": {
    inherits: ["staff-self"],
    grants: grantsForAdminRole("store_manager"),
  },
  "store-manager-2": {
    inherits: ["staff-self"],
    grants: grantsForAdminRole("store_manager_2"),
  },
  finance: {
    inherits: ["staff-self"],
    grants: grantsForAdminRole("finance"),
  },
  founder: {
    inherits: ["staff-self"],
    grants: grantsForAdminRole("founder"),
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
    throw new Error(
      `Permission template references unknown controller: ${typeKey}.${controllerName}`,
    );
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
      throw new Error(
        `Permission template references unknown action: ${typeKey}.${controllerName}.${actionName}`,
      );
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
  permissionTreeForActions: (strapi: Strapi, actions: readonly string[]) =>
    permissionTreeForActions(strapi, actions),
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

type RoleSyncSnapshot = {
  capturedAt: string;
  roles: Array<{
    id: number;
    name: string;
    type: string;
    description?: string | null;
    permissionActions: string[];
  }>;
  assignments: Array<{ userId: number; roleId: number }>;
};

type RoleDuplicateConsolidation = {
  definitionName: string;
  canonicalRoleId: number;
  duplicateRoleIds: number[];
};

// These generic category-content actions were intentionally removed with the
// bounded category-editorial API. Strapi drops their action definitions before
// our bootstrap snapshot runs, so they cannot be represented in (or restored
// from) the current controller tree. Every other unknown action still aborts.
const RETIRED_PERMISSION_ACTIONS = new Set([
  "api::product-category-content.product-category-content.find",
  "api::product-category-content.product-category-content.findOne",
  "api::product-category-content.product-category-content.create",
  "api::product-category-content.product-category-content.update",
  "api::product-category-content.product-category-content.delete",
]);

function permissionTreeForActions(strapi: Strapi, actionNames: readonly string[]) {
  const tree = strapi
    .plugin("users-permissions")
    .service("users-permissions")
    .getActions({ defaultEnable: false });
  const expected = new Set(actionNames);

  Object.entries(tree).forEach(([typeKey, typeEntry]: [string, any]) => {
    Object.entries(typeEntry?.controllers || {}).forEach(
      ([controllerName, controller]: [string, any]) => {
        Object.entries(controller || {}).forEach(([actionName, action]: [string, any]) => {
          const fullName = `${typeKey}.${controllerName}.${actionName}`;
          if (expected.has(fullName)) {
            action.enabled = true;
            expected.delete(fullName);
          }
        });
      },
    );
  });

  if (expected.size > 0) {
    throw new Error(
      `Role rollback preflight failed for unknown persisted actions: ${[...expected].join(",")}`,
    );
  }
  return tree;
}

async function captureRoleSyncSnapshot(
  strapi: Strapi,
  persistedRoles: any[],
): Promise<RoleSyncSnapshot> {
  const staffRoleIds = persistedRoles
    .filter(
      (role) =>
        role.type === "public" ||
        role.type === "customer" ||
        Boolean(ROLE_PERMISSION_SPECS[role.type]) ||
        Boolean(normalizeAdminRole(role.type) ?? normalizeAdminRole(role.name)),
    )
    .map((role) => Number(role.id));
  const userQuery = strapi.query("plugin::users-permissions.user") as any;
  const assignmentRows =
    staffRoleIds.length > 0 && typeof userQuery?.findMany === "function"
      ? await userQuery.findMany({
          where: { role: { id: { $in: staffRoleIds } } },
          select: ["id"],
          populate: { role: { select: ["id"] } },
        })
      : [];

  const snapshot: RoleSyncSnapshot = {
    capturedAt: new Date().toISOString(),
    roles: persistedRoles
      .filter((role) => staffRoleIds.includes(Number(role.id)))
      .map((role) => ({
        id: Number(role.id),
        name: String(role.name),
        type: String(role.type),
        description: role.description ?? null,
        permissionActions: ((role.permissions || []) as any[])
          .map((permission) => String(permission.action || ""))
          .filter(Boolean)
          .filter((action) => !RETIRED_PERMISSION_ACTIONS.has(action))
          .sort(),
      })),
    assignments: (assignmentRows as any[])
      .map((user) => ({ userId: Number(user.id), roleId: Number(user.role?.id ?? user.role) }))
      .filter(
        (assignment) =>
          Number.isSafeInteger(assignment.userId) && Number.isSafeInteger(assignment.roleId),
      ),
  };

  // Prove before the first write that the current controller tree can restore
  // every persisted permission action represented in the snapshot.
  snapshot.roles.forEach((role) => permissionTreeForActions(strapi, role.permissionActions));

  const storeFactory = (strapi as any).store;
  if (typeof storeFactory === "function") {
    const store = storeFactory({ type: "core", name: "admin-authorization" });
    const initialKey = "admin-capability-v1-initial-snapshot";
    if (!(await store.get({ key: initialKey }))) {
      await store.set({ key: initialKey, value: snapshot });
    }
    await store.set({ key: "admin-capability-v1-latest-pre-sync", value: snapshot });
    const persistedSnapshot = await store.get({ key: "admin-capability-v1-latest-pre-sync" });
    if (!persistedSnapshot || JSON.stringify(persistedSnapshot) !== JSON.stringify(snapshot)) {
      throw new Error("Role synchronization snapshot readback verification failed");
    }
  }

  return snapshot;
}

async function restoreRoleSyncSnapshot(
  strapi: Strapi,
  snapshot: RoleSyncSnapshot,
  createdRoleIds: readonly number[],
) {
  const roleQuery = strapi.query("plugin::users-permissions.role") as any;
  for (const roleId of [...createdRoleIds].reverse()) {
    await roleQuery.delete({ where: { id: roleId } });
  }
  for (const role of snapshot.roles) {
    await roleQuery.update({
      where: { id: role.id },
      data: { name: role.name, type: role.type, description: role.description },
    });
    const permissions = permissionTreeForActions(strapi, role.permissionActions);
    await strapi.plugin("users-permissions").service("role").updateRole(role.id, { permissions });
    await verifyPersistedRolePermissions(strapi, role, permissions);
  }

  const userQuery = strapi.query("plugin::users-permissions.user") as any;
  for (const assignment of snapshot.assignments) {
    const user = await userQuery.findOne({
      where: { id: assignment.userId },
      populate: { role: { select: ["id"] } },
    });
    if (Number(user?.role?.id ?? user?.role) !== assignment.roleId) {
      await userQuery.update({
        where: { id: assignment.userId },
        data: { role: assignment.roleId },
      });
      const restoredUser = await userQuery.findOne({
        where: { id: assignment.userId },
        populate: { role: { select: ["id"] } },
      });
      if (Number(restoredUser?.role?.id ?? restoredUser?.role) !== assignment.roleId) {
        throw new Error(
          `Role rollback assignment verification failed for user ${assignment.userId}`,
        );
      }
    }
  }
}

function planRoleDuplicateConsolidation(
  definition: {
    name: string;
    type: string;
    legacyNames: string[];
  },
  matches: any[],
): RoleDuplicateConsolidation | null {
  // A rollback to the pre-capability release can recreate the legacy
  // "Store manager" row after the canonical "Store Manager" row has already
  // been created. Only that exact, same-type pair is safe to consolidate.
  if (definition.type !== "store-manager" || matches.length !== 2) return null;

  const allowedNames = new Set([definition.name, ...definition.legacyNames]);
  const canonical = matches.find(
    (role) => role.name === definition.name && role.type === definition.type,
  );
  const duplicates = matches.filter((role) => Number(role.id) !== Number(canonical?.id));
  const isExpectedRollbackPair =
    canonical &&
    duplicates.length === 1 &&
    matches.every((role) => role.type === definition.type && allowedNames.has(String(role.name))) &&
    new Set(matches.map((role) => String(role.name))).size === matches.length;

  if (!isExpectedRollbackPair) return null;
  return {
    definitionName: definition.name,
    canonicalRoleId: Number(canonical.id),
    duplicateRoleIds: duplicates.map((role) => Number(role.id)),
  };
}

async function consolidateRoleDuplicates(
  strapi: Strapi,
  consolidations: RoleDuplicateConsolidation[],
) {
  const roleQuery = strapi.query("plugin::users-permissions.role") as any;
  const userQuery = strapi.query("plugin::users-permissions.user") as any;

  for (const consolidation of consolidations) {
    for (const duplicateRoleId of consolidation.duplicateRoleIds) {
      const users = await userQuery.findMany({
        where: { role: duplicateRoleId },
        select: ["id"],
        populate: { role: { select: ["id"] } },
      });
      for (const user of users || []) {
        await userQuery.update({
          where: { id: Number(user.id) },
          data: { role: consolidation.canonicalRoleId },
        });
        const reassigned = await userQuery.findOne({
          where: { id: Number(user.id) },
          populate: { role: { select: ["id"] } },
        });
        if (Number(reassigned?.role?.id ?? reassigned?.role) !== consolidation.canonicalRoleId) {
          throw new Error(`Role consolidation assignment verification failed for user ${user.id}`);
        }
      }
    }
  }

  // Deletions are deliberately last: every permission and assignment write is
  // verified while the pre-sync snapshot can still be restored exactly.
  for (const consolidation of consolidations) {
    for (const duplicateRoleId of consolidation.duplicateRoleIds) {
      await roleQuery.delete({ where: { id: duplicateRoleId } });
    }
    strapi.log.info(
      `Consolidated rollback-created duplicate role: ${consolidation.definitionName}`,
    );
  }
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
  permissionSpecType = role.type,
) {
  const roleType = permissionSpecType;
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
  const descriptions: Record<string, string> = {
    superadmin: "Full system administration",
    editor: "Blog-only content administration",
    "seller-1": "Non-destructive catalog administration",
    "seller-2": "Seller 1 plus categories, order read, status changes, and notes",
    "store-manager": "Same operational surface as Seller 2 (no analytics)",
    "store-manager-2": "Store Manager capabilities plus customer wallet administration",
    finance: "Seller 2 plus product, sales, cart, and finance reporting",
    founder: "Store Manager and Finance capabilities plus wallets, traffic, and manual orders",
    customer: "End customer role",
  };
  const roles = [
    ...Object.values(ADMIN_ROLE_DEFINITIONS).map((definition) => ({
      name: definition.strapiName,
      description: descriptions[definition.strapiType],
      type: definition.strapiType,
      legacyNames: definition.id === "store_manager" ? ["Store manager"] : [],
    })),
    {
      name: "Customer",
      description: descriptions.customer,
      type: "customer",
      legacyNames: [] as string[],
    },
  ];

  const persistedRoles = await strapi
    .query("plugin::users-permissions.role")
    .findMany({ populate: ["permissions"] });
  const duplicateConsolidations: RoleDuplicateConsolidation[] = [];
  for (const definition of roles) {
    const matches = (persistedRoles as any[]).filter(
      (role) =>
        role.type === definition.type ||
        role.name === definition.name ||
        definition.legacyNames.includes(role.name),
    );
    if (matches.length > 1) {
      const consolidation = planRoleDuplicateConsolidation(definition, matches);
      if (!consolidation) {
        throw new Error(
          `Role synchronization refused duplicate name/type collision for ${definition.name}`,
        );
      }
      duplicateConsolidations.push(consolidation);
    }
  }

  const existingSuperadmin = (persistedRoles as any[]).find(
    (role) => role.type === "superadmin" || role.name === "Superadmin",
  );
  // Strapi creates Public and Authenticated roles for a blank database before
  // this bootstrap runs. They are not evidence of an existing staff migration,
  // so they must not prevent the initial Superadmin role from being created.
  // Any pre-existing privileged role, however, is a populated authorization
  // model and still requires an existing Superadmin safety anchor.
  const hasPersistedPrivilegedRole = (persistedRoles as any[]).some(
    (role) => normalizeAdminRole(role.type) !== null || normalizeAdminRole(role.name) !== null,
  );
  if (hasPersistedPrivilegedRole && !existingSuperadmin) {
    throw new Error("Role synchronization requires an existing Superadmin role");
  }

  if (existingSuperadmin) {
    const userQuery = strapi.query("plugin::users-permissions.user") as any;
    if (typeof userQuery.count === "function") {
      const totalUsers = await userQuery.count({ where: {} });
      const activeSuperadmins = await userQuery.count({
        where: {
          role: existingSuperadmin.id,
          blocked: { $ne: true },
          IsActive: { $ne: false },
        },
      });
      if (totalUsers > 0 && activeSuperadmins < 1) {
        throw new Error("Role synchronization requires at least one active Superadmin user");
      }
    }
  }

  const snapshot = await captureRoleSyncSnapshot(strapi, persistedRoles as any[]);
  const createdRoleIds: number[] = [];
  try {
    for (const roleDefinition of roles) {
      const existing = (persistedRoles as any[]).find(
        (role) =>
          role.type === roleDefinition.type ||
          role.name === roleDefinition.name ||
          roleDefinition.legacyNames.includes(role.name),
      );
      const role = existing
        ? await strapi.query("plugin::users-permissions.role").update({
            where: { id: existing.id },
            data: {
              name: roleDefinition.name,
              description: roleDefinition.description,
              // The existing Store manager row is renamed in place while its
              // persisted type remains stable for compatibility.
              ...(roleDefinition.type === "store-manager" ? {} : { type: roleDefinition.type }),
            },
          })
        : await strapi.query("plugin::users-permissions.role").create({
            data: {
              name: roleDefinition.name,
              description: roleDefinition.description,
              type: roleDefinition.type,
            },
          });
      if (!existing) createdRoleIds.push(Number(role.id));

      strapi.log.info(
        `${existing ? "✓ Role already exists" : "✓ Created users-permissions role"}: ${
          roleDefinition.name
        }`,
        { roleId: role.id },
      );
      await assignRolePermissions(strapi, role as any, roleDefinition.type);
    }

    const publicRole = await strapi
      .query("plugin::users-permissions.role")
      .findOne({ where: { type: "public" } });
    if (!publicRole) {
      throw new Error("Public role not found; permissions could not be synchronized");
    }
    await assignRolePermissions(strapi, publicRole as any);
    await consolidateRoleDuplicates(strapi, duplicateConsolidations);
  } catch (error) {
    try {
      await restoreRoleSyncSnapshot(strapi, snapshot, createdRoleIds);
      strapi.log.error("Role synchronization failed; pre-sync snapshot restored and verified");
    } catch (rollbackError) {
      throw new Error(
        `Role synchronization failed and rollback verification failed: ${
          (rollbackError as Error).message
        }; original error: ${(error as Error).message}`,
      );
    }
    throw error;
  }
}

const authenticationRedisClient = createClient({
  url: process.env.REDIS_URL,
  ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
}).on("error", (err) => console.log("Redis Client Error", err));

// Type generation imports the application entrypoint but never uses runtime
// authentication/cache services. Do not open a socket that would keep the CLI
// alive after it has written the generated declarations.
export const RedisClient = process.argv.includes("ts:generate-types")
  ? Promise.resolve(authenticationRedisClient)
  : authenticationRedisClient
      .connect()
      .then((client) => {
        console.log("Redis connected");
        return client;
      })
      .catch((err) => {
        console.error("Failed to connect to Redis:", err.message);
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
    // Must be registered before `strapi::content-types.beforeSync` fires, which
    // is the last point at which a stale build can be stopped from dropping
    // columns the database already has.
    registerSchemaRegressionGuard(strapi);

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
      const auditStorage = await ensureAuditEventStorage(strapi);
      if (auditStorage.repaired) {
        strapi.log.info("Canonical audit storage protections installed after schema sync");
      }
      // These constraints also protect the shared payment-attempt workflow when
      // hardened SnappPay initiation is disabled, so keep them on every
      // PostgreSQL boot. A non-Postgres database still fails closed if hardened
      // initiation is explicitly enabled.
      await ensureSnappayDatabaseInvariants(strapi as any);
      // Mellat is always active (no feature flag), so its own payment-attempt
      // provider-reference invariant runs unconditionally alongside SnappPay's.
      await ensurePaymentAttemptDatabaseInvariants(strapi as any);
      await ensureCategoryEditorialDatabaseInvariant(strapi);
      const issueReportStorage = await ensureIssueReportStorage(strapi);
      if (issueReportStorage.repaired) {
        strapi.log.info("Issue report storage indexes installed after schema sync");
      }
      const modelApplicationStorage = await ensureModelApplicationStorage(strapi);
      if (modelApplicationStorage.repaired) {
        strapi.log.info("Model application storage indexes installed after schema sync");
      }
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
      try {
        startReconcileCartCleanupJob(strapi);
      } catch (error) {
        strapi.log.error("Failed to start cart cleanup reconciliation job", error);
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

    // v1 created an empty site-faq before collection-type FAQs were entered.
    // Copy leftover faq-category / faq-question rows into an empty site-faq once.
    (async function fillEmptySiteFaqFromLegacy() {
      try {
        const migrationStore = strapi.store({ type: "core", name: "migrations" });
        const migrationKey = "migrate-legacy-faq-into-empty-site-faq-v2";
        const alreadyRan = await migrationStore.get({ key: migrationKey });
        if (alreadyRan) {
          return;
        }

        const existing = await strapi.entityService.findMany("api::site-faq.site-faq", {
          populate: { categories: { populate: ["items"] } },
          limit: 1,
        });
        const record = (
          Array.isArray(existing) ? existing[0] : existing
        ) as { id?: number; categories?: unknown } | undefined;

        if (siteFaqHasQuestions(record?.categories)) {
          await migrationStore.set({
            key: migrationKey,
            value: { executedAt: new Date().toISOString(), skipped: "already-populated" },
          });
          return;
        }

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
        )) as LegacyFaqCategory[];

        const mapped = mapLegacyFaqCategories(legacyCategories);
        if (!siteFaqHasQuestions(mapped)) {
          await migrationStore.set({
            key: migrationKey,
            value: { executedAt: new Date().toISOString(), skipped: "legacy-empty" },
          });
          return;
        }

        if (record?.id) {
          await strapi.entityService.update("api::site-faq.site-faq", record.id, {
            data: { categories: mapped },
          });
        } else {
          await strapi.entityService.create("api::site-faq.site-faq", {
            data: { categories: mapped },
          });
        }

        await migrationStore.set({
          key: migrationKey,
          value: {
            executedAt: new Date().toISOString(),
            migratedCategories: mapped.length,
            migratedItems: mapped.reduce((sum, category) => sum + category.items.length, 0),
          },
        });
        strapi.log.info(
          `✓ Copied ${mapped.length} legacy FAQ categories into site-faq`,
        );
      } catch (error) {
        strapi.log.error("Failed to copy legacy FAQ into site-faq", {
          error: (error as Error)?.message,
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
