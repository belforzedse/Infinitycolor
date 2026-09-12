jest.mock("@sentry/node", () => ({ init: jest.fn() }));
jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    connect: jest.fn().mockResolvedValue({}),
  })),
}));
jest.unmock("../index");

import { hasCapability } from "@repo/auth-core";
import { __rolePermissionTestUtils } from "../index";

function action(enabled = false) {
  return { enabled };
}

function createActionTree() {
  const tree: Record<string, any> = {
    "api::auth": {
      controllers: {
        auth: {
          welcome: action(),
          otp: action(),
          login: action(),
          loginWithPassword: action(),
          resetPassword: action(),
          self: action(),
          updateSelf: action(),
          registerInfo: action(),
        },
      },
    },
    "api::cart": {
      controllers: {
        cart: {
          find: action(),
          findOne: action(),
          getMyCart: action(),
          addItem: action(),
          updateItem: action(),
          removeItem: action(),
          checkStock: action(),
          applyDiscount: action(),
          mergeGuestCart: action(),
          checkoutQuote: action(),
          finalizeToOrder: action(),
          shippingPreview: action(),
          shippingOptions: action(),
        },
      },
    },
    "api::commerce-maintenance": {
      controllers: {
        "commerce-maintenance": {
          purge: action(),
        },
      },
    },
    "api::discount": {
      controllers: {
        discount: {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::general-discount": {
      controllers: {
        "general-discount": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product": {
      controllers: {
        product: {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          search: action(),
          publication: action(),
          updateDisplayDate: action(),
          generateVariationCombinations: action(),
          softDelete: action(),
          restore: action(),
          delete: action(),
        },
      },
    },
    "api::product-category-content": {
      controllers: {
        "product-category-content": {
          targets: action(),
          editable: action(),
          upsert: action(),
          publicBySlug: action(),
        },
      },
    },
    "api::product-faq": {
      controllers: {
        "product-faq": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-size-helper": {
      controllers: {
        "product-size-helper": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-tag": {
      controllers: {
        "product-tag": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-variation": {
      controllers: {
        "product-variation": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-stock": {
      controllers: {
        "product-stock": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-variation-color": {
      controllers: {
        "product-variation-color": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-variation-size": {
      controllers: {
        "product-variation-size": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-variation-model": {
      controllers: {
        "product-variation-model": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-attribute": {
      controllers: {
        "product-attribute": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-attribute-term": {
      controllers: {
        "product-attribute-term": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-attribute-assignment": {
      controllers: {
        "product-attribute-assignment": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::shipping": {
      controllers: {
        shipping: {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::shipping-province": {
      controllers: {
        "shipping-province": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::shipping-city": {
      controllers: {
        "shipping-city": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::order": {
      controllers: {
        order: {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
          getMyOrders: action(),
          getMyOrderDetail: action(),
          checkPaymentStatus: action(),
          reconcilePayment: action(),
          getActiveReserve: action(),
          releaseReserve: action(),
          listMyReserveGroups: action(),
          getMyReserveGroup: action(),
          verifyPayment: action(),
          adminAdjustItems: action(),
          adminUpdateNotes: action(),
          adminTransition: action(),
          adminCancel: action(),
          adminPaymentOperation: action(),
          adminVoidBarcode: action(),
          generateAnipoBarcode: action(),
          checkAnipoBarcode: action(),
          decrementStockManual: action(),
        },
      },
    },
    "api::admin-order-list": {
      controllers: {
        "admin-order-list": {
          query: action(),
          queryReserveGroups: action(),
          getReserveGroup: action(),
        },
      },
    },
    "api::admin-product-list": {
      controllers: {
        "admin-product-list": { query: action() },
      },
    },
    "api::product-review": {
      controllers: {
        "product-review": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
          submitReview: action(),
          getUserReviews: action(),
        },
      },
    },
    "api::product-review-reply": {
      controllers: {
        "product-review-reply": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::plugin-user": {
      controllers: {
        "plugin-user": { createPluginUser: action(), searchCustomers: action() },
      },
    },
    "plugin::upload": {
      controllers: {
        "content-api": { find: action(), findOne: action(), upload: action(), destroy: action() },
      },
    },
    "api::payment-gateway": {
      controllers: {
        "payment-gateway": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
          availableGateways: action(),
          snappEligible: action(),
          testMellat: action(),
          testMellatV2: action(),
          testMellatV3: action(),
        },
      },
    },
    "api::payment-attempt": {
      controllers: {
        "payment-attempt": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
        },
      },
    },
    "api::payment-operation": {
      controllers: {
        "payment-operation": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
        },
      },
    },
    "api::contract": {
      controllers: {
        contract: {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::contract-transaction": {
      controllers: {
        "contract-transaction": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::product-category": {
      controllers: {
        "product-category": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
          deleteWithReassign: action(),
        },
      },
    },
    "api::admin-activity": {
      controllers: {
        "admin-activity": {
          find: action(),
          findOne: action(),
          findMyActivities: action(),
          findOrderActivities: action(),
          findUserActivities: action(),
          findProductActivities: action(),
          findReport: action(),
        },
      },
    },
    "api::report": {
      controllers: {
        report: {
          liquidity: action(),
          productSales: action(),
          productOverview: action(),
          productTrends: action(),
          productBreakdown: action(),
          productPerformance: action(),
          productInventory: action(),
          productDetail: action(),
          productExport: action(),
          gatewayLiquidity: action(),
          adminActivity: action(),
          adminActivityById: action(),
          trafficDashboard: action(),
          trafficRealtime: action(),
          funnel: action(),
          behaviorOverview: action(),
          behaviorAcquisition: action(),
          behaviorConversion: action(),
          behaviorContent: action(),
          behaviorAudience: action(),
          behaviorPerformance: action(),
          behaviorRealtime: action(),
          salesBreakdown: action(),
          salesBreakdownExport: action(),
          overview: action(),
        },
      },
    },
    "plugin::users-permissions": {
      controllers: {
        user: {
          find: action(),
          findOne: action(),
          update: action(),
        },
        role: {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::local-user": {
      controllers: {
        "local-user": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
          createUser: action(),
          updateUser: action(),
        },
      },
    },
    "api::local-user-wallet": {
      controllers: {
        "local-user-wallet": {
          getCurrentUserWallet: action(),
          adminGetUserWallet: action(),
          adminGetUserWalletHistory: action(),
          adminAdjustWallet: action(),
        },
      },
    },
    "api::wallet-topup": {
      controllers: {
        "wallet-topup": {
          chargeIntent: action(),
          paymentCallback: action(),
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
    "api::local-user-wallet-transaction": {
      controllers: {
        "local-user-wallet-transaction": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
        },
      },
    },
  };

  const addController = (typeKey: string, controllerName: string, actions: string[]) => {
    tree[typeKey] ||= { controllers: {} };
    tree[typeKey].controllers[controllerName] ||= {};
    for (const actionName of actions) {
      tree[typeKey].controllers[controllerName][actionName] ||= action();
    }
  };
  const crud = ["find", "findOne", "create", "update", "delete"];

  for (const [typeKey, controllerName, actions] of [
    ["api::admin-dashboard", "admin-dashboard", ["query"]],
    ["api::admin-user", "admin-user", ["query"]],
    ["api::event-log", "event-log", ["getMyEvents", "getOrderEvents", "getAdminEvents"]],
    [
      "api::issue-report",
      "issue-report",
      ["create", "query", "findOne", "updateStatus", "exportReport"],
    ],
    [
      "api::model-application",
      "model-application",
      ["create", "query", "findOne", "updateStatus"],
    ],
    ["api::commerce-maintenance", "commerce-maintenance", ["purge"]],
    ["api::cart-item", "cart-item", crud],
    ["api::order-item", "order-item", crud],
    ["api::product-review-like", "product-review-like", crud],
    ["api::navigation", "navigation", crud],
    ["api::footer", "footer", crud],
    ["api::site-identity", "site-identity", crud],
    ["api::site-faq", "site-faq", crud],
    [
      "api::settings",
      "settings",
      [
        ...crud,
        "getBlogBanners",
        "updateBlogBanners",
        "getHomepageProducts",
        "updateHomepageProducts",
        "getGifPromoProducts",
        "updateGifPromoProducts",
        "getHomepageCustomSection",
        "updateHomepageCustomSection",
        "getHeroSlider",
        "updateHeroSliderDraft",
        "publishHeroSliderDraft",
      ],
    ],
    ["api::blog-post", "blog-post", crud],
    ["api::blog-category", "blog-category", crud],
    ["api::blog-tag", "blog-tag", crud],
    ["api::blog-author", "blog-author", crud],
    ["api::blog-comment", "blog-comment", [...crud, "approve", "reject"]],
    ["api::post", "post", crud],
    ["api::post-comment", "post-comment", [...crud, "approve", "reject"]],
    ["api::faq-category", "faq-category", crud],
    ["api::faq-question", "faq-question", crud],
    ["api::story", "story", [...crud, "getActive"]],
    ["api::product-like", "product-like", ["toggleFavorite", "getUserLikes"]],
    ["api::post-like", "post-like", ["toggle", "getUserLikes"]],
    ["api::post-bookmark", "post-bookmark", ["toggle", "getUserBookmarks"]],
    ["api::post-comment-like", "post-comment-like", ["toggle", "getUserLikes"]],
    ["api::notification", "notification", ["listMine", "unreadCount", "markAllRead", "markRead"]],
    [
      "api::user-activity",
      "user-activity",
      [
        "findUserActivities",
        "findUserActivitiesByUserId",
        "unreadCount",
        "markRead",
        "markAllRead",
      ],
    ],
    ["api::local-user-address", "local-user-address", [...crud, "getMyAddresses", "createAddress"]],
    ["api::story-seen", "story-seen", ["markSeen", "getMine"]],
  ] as Array<[string, string, string[]]>) {
    addController(typeKey, controllerName, actions);
  }

  return tree;
}

function createStrapiForPermissions() {
  return {
    log: { warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
    plugin: jest.fn(() => ({
      service: jest.fn(() => ({
        getActions: jest.fn(({ defaultEnable }: { defaultEnable: boolean }) => {
          const tree = createActionTree();
          Object.values(tree).forEach((entry: any) => {
            Object.values(entry.controllers).forEach((controller: any) => {
              Object.values(controller).forEach((entryAction: any) => {
                entryAction.enabled = defaultEnable;
              });
            });
          });
          return tree;
        }),
      })),
    })),
  };
}

function enabledActionNames(controller: Record<string, { enabled: boolean }>) {
  return Object.entries(controller)
    .filter(([, value]) => value.enabled)
    .map(([name]) => name)
    .sort();
}

describe("role permission templates", () => {
  it("keeps cart lines and raw inventory off the public and customer roles", () => {
    const publicRole = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "public",
    );
    const customer = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "customer",
    );
    const enabled = (tree: Record<string, any>, typeKey: string, controllerName: string) =>
      enabledActionNames(tree[typeKey].controllers[controllerName]);

    // /cart-items is a default core router: a public find/findOne lets anyone
    // enumerate every customer's cart lines by id. Carts are read via /carts/me.
    expect(enabled(publicRole, "api::cart-item", "cart-item")).toEqual([]);
    expect(enabled(customer, "api::cart-item", "cart-item")).toEqual([]);

    // Raw inventory persistence stays with staff. Storefront availability reaches
    // the client through the product / product-variation populate of product_stock.
    expect(enabled(publicRole, "api::product-stock", "product-stock")).toEqual([]);
    expect(enabled(customer, "api::product-stock", "product-stock")).toEqual([]);

    // The catalog reads the storefront actually depends on are untouched.
    expect(enabled(publicRole, "api::product", "product")).toEqual(["find", "findOne", "search"]);
    expect(enabled(publicRole, "api::product-category", "product-category")).toEqual([
      "find",
      "findOne",
    ]);
    expect(enabled(publicRole, "api::product-variation", "product-variation")).toEqual([
      "find",
      "findOne",
    ]);
    expect(enabled(publicRole, "api::issue-report", "issue-report")).toEqual(["create"]);
    expect(enabled(publicRole, "api::model-application", "model-application")).toEqual(["create"]);
    expect(enabled(publicRole, "plugin::upload", "content-api")).toEqual([]);
    // Customers still drive their own cart through the scoped cart controller.
    expect(enabled(customer, "api::cart", "cart")).toEqual(
      expect.arrayContaining(["getMyCart", "addItem", "updateItem", "removeItem"]),
    );
  });

  it("lets customers file moderated comments without reaching review core writes", () => {
    const publicRole = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "public",
    );
    const customer = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "customer",
    );
    const enabled = (tree: Record<string, any>, typeKey: string, controllerName: string) =>
      enabledActionNames(tree[typeKey].controllers[controllerName]);

    // The blog-comment `create` override forces Status "Pending", takes the
    // author from the session, and whitelists the writable fields, so the
    // grant cannot be used to self-approve or reparent someone else's thread.
    expect(enabled(customer, "api::blog-comment", "blog-comment")).toEqual([
      "create",
      "find",
      "findOne",
    ]);
    // Anonymous visitors must still not be able to post.
    expect(enabled(publicRole, "api::blog-comment", "blog-comment")).toEqual(["find", "findOne"]);

    // Reviews go through /product-reviews/submit, which owns the moderation
    // status. Core `create` would let a customer post Status "Accepted".
    expect(enabled(customer, "api::product-review", "product-review")).toEqual([
      "find",
      "findOne",
      "getUserReviews",
      "submitReview",
    ]);
  });

  it("lets Seller 1 query the bounded admin products list without order access", () => {
    const seller1 = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "seller-1",
    );
    const editor = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "editor",
    );

    expect(seller1["api::admin-product-list"].controllers["admin-product-list"].query.enabled).toBe(
      true,
    );
    expect(seller1["api::admin-order-list"].controllers["admin-order-list"].query.enabled).toBe(
      false,
    );
    expect(
      seller1["api::admin-order-list"].controllers["admin-order-list"].queryReserveGroups
        .enabled,
    ).toBe(false);
    expect(
      seller1["api::admin-order-list"].controllers["admin-order-list"].getReserveGroup
        .enabled,
    ).toBe(false);
    expect(editor["api::admin-product-list"].controllers["admin-product-list"].query.enabled).toBe(
      false,
    );
  });

  it("wires capability-gated handlers for every staff role that holds the capability", () => {
    const strapiRoleType: Record<string, string> = {
      support: "support",
      editor: "editor",
      seller1: "seller-1",
      seller2: "seller-2",
      store_manager: "store-manager",
      store_manager_2: "store-manager-2",
      finance: "finance",
      founder: "founder",
      superadmin: "superadmin",
    };

    // Capability → U&P actions that must be enabled together. Keep in sync with
    // custom routers that use global::require-capability.
    const gated: Array<{ capabilities: string[]; actions: string[] }> = [
      {
        capabilities: ["product.read"],
        actions: ["api::admin-product-list.admin-product-list.query"],
      },
      {
        capabilities: ["content.categoryEditorial.manage"],
        actions: [
          "api::product-category-content.product-category-content.targets",
          "api::product-category-content.product-category-content.editable",
          "api::product-category-content.product-category-content.upsert",
        ],
      },
      {
        capabilities: ["product.variation.manage"],
        actions: ["api::product.product.generateVariationCombinations"],
      },
      {
        capabilities: ["product.publish", "product.schedule"],
        actions: ["api::product.product.publication"],
      },
      {
        capabilities: ["product.schedule"],
        actions: ["api::product.product.updateDisplayDate"],
      },
      {
        capabilities: ["product.softDelete"],
        actions: ["api::product.product.softDelete"],
      },
      {
        capabilities: ["product.restore"],
        actions: ["api::product.product.restore"],
      },
      {
        capabilities: ["product.homepage.manage"],
        actions: [
          "api::settings.settings.getHomepageProducts",
          "api::settings.settings.updateHomepageProducts",
          "api::settings.settings.getGifPromoProducts",
          "api::settings.settings.updateGifPromoProducts",
          "api::settings.settings.getHomepageCustomSection",
          "api::settings.settings.updateHomepageCustomSection",
        ],
      },
      {
        capabilities: ["order.read"],
        actions: [
          "api::admin-order-list.admin-order-list.query",
          "api::admin-order-list.admin-order-list.queryReserveGroups",
          "api::admin-order-list.admin-order-list.getReserveGroup",
        ],
      },
      {
        capabilities: ["order.status.update"],
        actions: ["api::order.order.adminTransition"],
      },
      {
        capabilities: ["order.notes.update"],
        actions: ["api::order.order.adminUpdateNotes"],
      },
      {
        capabilities: ["order.cancel"],
        actions: ["api::order.order.adminCancel"],
      },
      {
        capabilities: ["order.financial.read"],
        actions: ["api::order.order.adminPaymentOperation"],
      },
      {
        capabilities: ["order.manual.create"],
        actions: ["api::order.order.create", "api::order.order.decrementStockManual"],
      },
      {
        capabilities: ["report.product.read"],
        actions: ["api::report.report.productSales", "api::report.report.productOverview"],
      },
      {
        capabilities: ["report.sales.read"],
        actions: ["api::report.report.overview", "api::report.report.salesBreakdown"],
      },
      {
        capabilities: ["report.finance.read"],
        actions: ["api::report.report.liquidity", "api::report.report.gatewayLiquidity"],
      },
      {
        capabilities: ["report.traffic.read"],
        actions: ["api::report.report.behaviorOverview"],
      },
      {
        capabilities: ["report.carts.read"],
        actions: ["api::cart.cart.find"],
      },
      {
        capabilities: ["wallet.customer.search"],
        actions: ["api::plugin-user.plugin-user.searchCustomers"],
      },
      {
        capabilities: ["wallet.read"],
        actions: ["api::local-user-wallet.local-user-wallet.adminGetUserWallet"],
      },
      {
        capabilities: ["wallet.history.read"],
        actions: ["api::local-user-wallet.local-user-wallet.adminGetUserWalletHistory"],
      },
      {
        capabilities: ["wallet.adjust"],
        actions: ["api::local-user-wallet.local-user-wallet.adminAdjustWallet"],
      },
      {
        capabilities: ["content.blog.banners.manage"],
        actions: [
          "api::settings.settings.getBlogBanners",
          "api::settings.settings.updateBlogBanners",
        ],
      },
      {
        capabilities: ["content.blog.comments.manage"],
        actions: [
          "api::blog-comment.blog-comment.approve",
          "api::blog-comment.blog-comment.reject",
          "api::post-comment.post-comment.approve",
          "api::post-comment.post-comment.reject",
        ],
      },
      {
        capabilities: ["content.stories.manage"],
        actions: [
          "api::story.story.create",
          "api::story.story.update",
          "api::story.story.delete",
        ],
      },
      {
        capabilities: ["system.users.manage"],
        actions: [
          "api::admin-user.admin-user.query",
          "api::plugin-user.plugin-user.createPluginUser",
          "api::local-user.local-user.createUser",
        ],
      },
      {
        capabilities: ["system.audit.read"],
        actions: [
          "api::admin-activity.admin-activity.findReport",
          "api::admin-activity.admin-activity.findProductActivities",
        ],
      },
      {
        capabilities: ["system.reviews.manage"],
        actions: [
          "api::product-review.product-review.update",
          "api::product-review.product-review.delete",
          "api::product-review-reply.product-review-reply.create",
          "api::product-review-reply.product-review-reply.delete",
        ],
      },
      {
        capabilities: ["system.issueReports.manage"],
        actions: [
          "api::issue-report.issue-report.query",
          "api::issue-report.issue-report.findOne",
          "api::issue-report.issue-report.updateStatus",
          "api::issue-report.issue-report.exportReport",
        ],
      },
      {
        capabilities: ["system.modelApplications.manage"],
        actions: [
          "api::model-application.model-application.query",
          "api::model-application.model-application.findOne",
          "api::model-application.model-application.updateStatus",
        ],
      },
      {
        capabilities: ["system.customization.manage"],
        actions: [
          "api::settings.settings.getHeroSlider",
          "api::settings.settings.updateHeroSliderDraft",
          "api::settings.settings.publishHeroSliderDraft",
        ],
      },
      {
        capabilities: ["system.purge.execute"],
        actions: ["api::commerce-maintenance.commerce-maintenance.purge"],
      },
    ];

    const parseAction = (full: string) => {
      const match = full.match(/^(api::[^.]+|plugin::[^.]+)\.([^.]+)\.(.+)$/);
      if (!match) throw new Error(`Bad action name ${full}`);
      return { typeKey: match[1], controller: match[2], action: match[3] };
    };

    const gaps: string[] = [];
    const leaks: string[] = [];

    for (const role of [
      "support",
      "editor",
      "seller1",
      "seller2",
      "store_manager",
      "store_manager_2",
      "finance",
      "founder",
      "superadmin",
    ] as const) {
      const tree = __rolePermissionTestUtils.getDefaultPermissions(
        createStrapiForPermissions() as any,
        strapiRoleType[role],
      );

      for (const entry of gated) {
        const allowed =
          role === "superadmin" ||
          entry.capabilities.some((capability) => hasCapability(role, capability as any));
        for (const full of entry.actions) {
          const { typeKey, controller, action } = parseAction(full);
          const enabled = Boolean(tree[typeKey]?.controllers?.[controller]?.[action]?.enabled);
          if (allowed && !enabled) {
            gaps.push(`${role} has ${entry.capabilities.join(" or ")} but missing ${full}`);
          }
          if (!allowed && enabled) {
            leaks.push(`${role} lacks ${entry.capabilities.join(" and ")} but has ${full}`);
          }
        }
      }
    }

    expect(gaps).toEqual([]);
    expect(leaks).toEqual([]);
  });

  it("gives store managers no product insights or traffic/audit reports", () => {
    const storeManager = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager",
    );

    expect(
      storeManager["api::admin-activity"].controllers["admin-activity"].findOrderActivities.enabled,
    ).toBe(false);
    expect(
      storeManager["api::admin-activity"].controllers["admin-activity"].findProductActivities
        .enabled,
    ).toBe(false);
    expect(
      storeManager["api::admin-activity"].controllers["admin-activity"].findReport.enabled,
    ).toBe(false);
    expect(storeManager["api::report"].controllers.report.productSales.enabled).toBe(false);
    expect(storeManager["api::report"].controllers.report.behaviorOverview.enabled).toBe(false);
  });

  it("lets manager-plus roles edit products without opening product activity logs", () => {
    const storeManager = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager",
    );
    const founder = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "founder",
    );

    for (const tree of [storeManager, founder]) {
      const product = tree["api::product"].controllers.product;
      expect(product.findOne.enabled).toBe(true);
      expect(product.update.enabled).toBe(true);
      expect(product.delete.enabled).toBe(false);
      expect(
        tree["api::admin-activity"].controllers["admin-activity"].findProductActivities.enabled,
      ).toBe(false);
    }
  });

  it("lets store managers create and edit categories without granting destructive deletion", () => {
    const storeManager = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager",
    );
    const category = storeManager["api::product-category"].controllers["product-category"];

    expect(category.find.enabled).toBe(true);
    expect(category.findOne.enabled).toBe(true);
    expect(category.create.enabled).toBe(true);
    expect(category.update.enabled).toBe(true);
    expect(category.delete.enabled).toBe(false);
    expect(category.deleteWithReassign.enabled).toBe(false);
  });

  it("lets founders delete categories with reassignment", () => {
    const founder = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "founder",
    );
    const category = founder["api::product-category"].controllers["product-category"];

    expect(category.create.enabled).toBe(true);
    expect(category.update.enabled).toBe(true);
    expect(category.delete.enabled).toBe(true);
    expect(category.deleteWithReassign.enabled).toBe(true);
  });

  it("keeps product category creation unavailable to editors", () => {
    const editor = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "editor",
    );
    const category = editor["api::product-category"].controllers["product-category"];

    expect(category.find.enabled).toBe(true);
    expect(category.findOne.enabled).toBe(true);
    expect(category.create.enabled).toBe(false);
    expect(editor["api::payment-attempt"].controllers["payment-attempt"].find.enabled).toBe(false);
    expect(editor["plugin::users-permissions"].controllers.role.update.enabled).toBe(false);
  });

  it("keeps founder activity access behind the separate audit capability", () => {
    const founder = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "founder",
    );

    const adminActivity = founder["api::admin-activity"].controllers["admin-activity"];
    expect(adminActivity.findOrderActivities.enabled).toBe(false);
    expect(adminActivity.find.enabled).toBe(false);
    expect(adminActivity.findOne.enabled).toBe(false);
    expect(adminActivity.findReport.enabled).toBe(false);
    expect(adminActivity.findUserActivities.enabled).toBe(false);
    expect(adminActivity.findProductActivities.enabled).toBe(false);
  });

  it("allows founders to use inherited product, finance, sales, and traffic reports", () => {
    const founder = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "founder",
    );

    const report = founder["api::report"].controllers.report;
    expect(report.productSales.enabled).toBe(true);
    expect(report.productOverview.enabled).toBe(true);
    expect(report.productTrends.enabled).toBe(true);
    expect(report.productBreakdown.enabled).toBe(true);
    expect(report.productPerformance.enabled).toBe(true);
    expect(report.productInventory.enabled).toBe(true);
    expect(report.productDetail.enabled).toBe(true);
    expect(report.productExport.enabled).toBe(true);
    expect(report.liquidity.enabled).toBe(true);
    expect(report.gatewayLiquidity.enabled).toBe(true);
    expect(report.adminActivity.enabled).toBe(false);
    expect(report.adminActivityById.enabled).toBe(false);
    expect(report.behaviorOverview.enabled).toBe(true);
    expect(report.behaviorAcquisition.enabled).toBe(true);
    expect(report.behaviorConversion.enabled).toBe(true);
    expect(report.behaviorContent.enabled).toBe(true);
    expect(report.behaviorAudience.enabled).toBe(true);
    expect(report.behaviorPerformance.enabled).toBe(true);
    expect(report.behaviorRealtime.enabled).toBe(true);
    expect(report.trafficDashboard.enabled).toBe(false);
    expect(report.trafficRealtime.enabled).toBe(false);
    expect(report.funnel.enabled).toBe(false);
  });

  it("can snapshot legacy traffic permissions before synchronizing the Umami actions", () => {
    const strapi = createStrapiForPermissions() as any;
    const legacyActions = [
      "api::report.report.trafficDashboard",
      "api::report.report.trafficRealtime",
      "api::report.report.funnel",
    ];

    const snapshotTree = __rolePermissionTestUtils.permissionTreeForActions(strapi, legacyActions);
    const report = snapshotTree["api::report"].controllers.report;
    expect(report.trafficDashboard.enabled).toBe(true);
    expect(report.trafficRealtime.enabled).toBe(true);
    expect(report.funnel.enabled).toBe(true);
  });

  it("keeps manager-plus roles customer-capable but away from superadmin-only actions", () => {
    const founder = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "founder",
    );

    expect(founder["api::cart"].controllers.cart.getMyCart.enabled).toBe(true);
    expect(founder["api::cart"].controllers.cart.finalizeToOrder.enabled).toBe(true);
    expect(
      founder["api::commerce-maintenance"].controllers["commerce-maintenance"].purge.enabled,
    ).toBe(false);
    expect(
      founder["api::product-category"].controllers["product-category"].delete.enabled,
    ).toBe(true);
    expect(
      founder["api::product-category"].controllers["product-category"].deleteWithReassign.enabled,
    ).toBe(true);
    expect(founder["plugin::users-permissions"].controllers.user.find.enabled).toBe(false);
    expect(founder["plugin::users-permissions"].controllers.user.update.enabled).toBe(false);
  });

  it("grants the non-destructive operational commerce matrix without raw financial access", () => {
    const storeManager = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager",
    );
    const controller = (typeKey: string, name: string) => storeManager[typeKey].controllers[name];

    expect(controller("api::product", "product").generateVariationCombinations.enabled).toBe(true);
    expect(controller("api::product-variation", "product-variation").delete.enabled).toBe(false);
    expect(controller("api::product-stock", "product-stock").create.enabled).toBe(true);
    expect(controller("api::product-stock", "product-stock").update.enabled).toBe(true);
    expect(controller("api::product-stock", "product-stock").delete.enabled).toBe(false);

    for (const [typeKey, name] of [["api::product-faq", "product-faq"]]) {
      expect(controller(typeKey, name).create.enabled).toBe(true);
      expect(controller(typeKey, name).update.enabled).toBe(true);
      expect(controller(typeKey, name).delete.enabled).toBe(false);
    }
    const categoryEditorial = controller(
      "api::product-category-content",
      "product-category-content",
    );
    expect(categoryEditorial.targets.enabled).toBe(false);
    expect(categoryEditorial.editable.enabled).toBe(false);
    expect(categoryEditorial.upsert.enabled).toBe(false);
    expect(controller("api::product-size-helper", "product-size-helper").create.enabled).toBe(true);
    expect(controller("api::product-size-helper", "product-size-helper").update.enabled).toBe(true);
    expect(controller("api::product-size-helper", "product-size-helper").delete.enabled).toBe(
      false,
    );

    expect(controller("api::product-tag", "product-tag").create.enabled).toBe(true);
    expect(controller("api::product-tag", "product-tag").update.enabled).toBe(true);
    expect(controller("api::product-tag", "product-tag").delete.enabled).toBe(false);

    for (const [typeKey, name] of [
      ["api::product-variation-color", "product-variation-color"],
      ["api::product-variation-size", "product-variation-size"],
      ["api::product-variation-model", "product-variation-model"],
      ["api::product-attribute", "product-attribute"],
      ["api::product-attribute-term", "product-attribute-term"],
    ]) {
      expect(controller(typeKey, name).create.enabled).toBe(true);
      expect(controller(typeKey, name).update.enabled).toBe(true);
      expect(controller(typeKey, name).delete.enabled).toBe(false);
    }

    // The only delete in this otherwise create/update-only catalog matrix. An
    // assignment is a join row (product × attribute): removing one detaches an
    // attribute from a single product and destroys no shared data, unlike the
    // colour/size/model/term rows above, which other products reference. Sellers
    // could attach a custom attribute but never detach it until this was granted.
    expect(
      controller("api::product-attribute-assignment", "product-attribute-assignment").delete
        .enabled,
    ).toBe(true);
    expect(controller("api::discount", "discount").create.enabled).toBe(false);
    expect(controller("api::discount", "discount").update.enabled).toBe(false);
    expect(controller("api::discount", "discount").delete.enabled).toBe(false);
    expect(controller("api::general-discount", "general-discount").create.enabled).toBe(false);
    expect(controller("api::shipping", "shipping").create.enabled).toBe(false);
    expect(controller("api::shipping", "shipping").delete.enabled).toBe(false);
    expect(controller("api::shipping-province", "shipping-province").update.enabled).toBe(false);
    expect(controller("api::shipping-city", "shipping-city").create.enabled).toBe(false);

    const order = controller("api::order", "order");
    expect(order.find.enabled).toBe(false);
    expect(order.adminAdjustItems.enabled).toBe(false);
    expect(order.adminUpdateNotes.enabled).toBe(true);
    expect(order.adminTransition.enabled).toBe(true);
    expect(order.adminCancel.enabled).toBe(true);
    expect(order.create.enabled).toBe(false);
    expect(order.update.enabled).toBe(false);
    expect(order.delete.enabled).toBe(false);
    expect(order.adminPaymentOperation.enabled).toBe(false);

    expect(controller("api::plugin-user", "plugin-user").searchCustomers.enabled).toBe(false);
    expect(controller("api::plugin-user", "plugin-user").createPluginUser.enabled).toBe(false);
    expect(controller("api::local-user", "local-user").createUser.enabled).toBe(false);
    expect(controller("api::local-user", "local-user").update.enabled).toBe(false);
    expect(controller("plugin::users-permissions", "role").find.enabled).toBe(false);
    expect(controller("plugin::users-permissions", "role").update.enabled).toBe(false);
    expect(controller("plugin::upload", "content-api").upload.enabled).toBe(true);
    expect(controller("plugin::upload", "content-api").destroy.enabled).toBe(false);

    for (const [typeKey, name] of [
      ["api::payment-attempt", "payment-attempt"],
      ["api::payment-operation", "payment-operation"],
      ["api::contract", "contract"],
      ["api::contract-transaction", "contract-transaction"],
    ]) {
      expect(controller(typeKey, name).find.enabled).toBe(false);
      expect(controller(typeKey, name).update.enabled).toBe(false);
    }

    const gateway = controller("api::payment-gateway", "payment-gateway");
    expect(gateway.availableGateways.enabled).toBe(true);
    expect(gateway.snappEligible.enabled).toBe(true);
    expect(gateway.find.enabled).toBe(false);
    expect(gateway.update.enabled).toBe(false);

    const walletTransactions = controller(
      "api::local-user-wallet-transaction",
      "local-user-wallet-transaction",
    );
    expect(walletTransactions.find.enabled).toBe(true);
    expect(walletTransactions.findOne.enabled).toBe(true);
    expect(walletTransactions.create.enabled).toBe(false);
    expect(walletTransactions.update.enabled).toBe(false);
  });

  it("matches the exact Store Manager action allowlist across commerce domains", () => {
    const tree = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager",
    );
    const enabled = (typeKey: string, controllerName: string) =>
      enabledActionNames(tree[typeKey].controllers[controllerName]);

    // softDelete/restore are the reversible recycle-bin pair, inherited from
    // Seller 1. Note "delete" is still absent: permanent deletion stays
    // Superadmin-only.
    expect(enabled("api::product", "product")).toEqual([
      "create",
      "find",
      "findOne",
      "generateVariationCombinations",
      "publication",
      "restore",
      "search",
      "softDelete",
      "update",
      "updateDisplayDate",
    ]);
    expect(enabled("api::product-category", "product-category")).toEqual([
      "create",
      "find",
      "findOne",
      "update",
    ]);
    expect(enabled("api::product-variation", "product-variation")).toEqual([
      "create",
      "find",
      "findOne",
      "update",
    ]);
    expect(enabled("api::product-stock", "product-stock")).toEqual([
      "create",
      "find",
      "findOne",
      "update",
    ]);
    expect(enabled("api::discount", "discount")).toEqual([]);
    expect(enabled("api::general-discount", "general-discount")).toEqual([]);
    expect(enabled("api::shipping", "shipping")).toEqual(["find", "findOne"]);
    expect(enabled("api::shipping-province", "shipping-province")).toEqual(["find", "findOne"]);
    expect(enabled("api::shipping-city", "shipping-city")).toEqual(["find", "findOne"]);
    expect(enabled("api::order", "order")).toEqual([
      "adminCancel",
      "adminTransition",
      "adminUpdateNotes",
      "checkPaymentStatus",
      "findOne",
      "getActiveReserve",
      "getMyOrderDetail",
      "getMyOrders",
      "getMyReserveGroup",
      "listMyReserveGroups",
      "reconcilePayment",
      "releaseReserve",
      "verifyPayment",
    ]);
    expect(enabled("api::admin-order-list", "admin-order-list")).toEqual([
      "getReserveGroup",
      "query",
      "queryReserveGroups",
    ]);
    expect(enabled("api::product-review", "product-review")).toEqual([
      "find",
      "findOne",
      "getUserReviews",
      "submitReview",
    ]);
    expect(enabled("api::product-review-reply", "product-review-reply")).toEqual([
      "find",
      "findOne",
    ]);
    expect(enabled("plugin::upload", "content-api")).toEqual(["find", "findOne", "upload"]);
    expect(enabled("api::payment-gateway", "payment-gateway")).toEqual([
      "availableGateways",
      "snappEligible",
    ]);
    expect(enabled("api::wallet-topup", "wallet-topup")).toEqual(["paymentCallback"]);
    expect(enabled("api::local-user-wallet", "local-user-wallet")).toEqual([
      "getCurrentUserWallet",
    ]);
    expect(enabled("api::local-user-wallet-transaction", "local-user-wallet-transaction")).toEqual([
      "find",
      "findOne",
    ]);
    expect(enabled("plugin::users-permissions", "user")).toEqual([]);
    expect(enabled("plugin::users-permissions", "role")).toEqual([]);
    expect(enabled("api::admin-activity", "admin-activity")).toEqual([]);
    expect(enabled("api::report", "report")).toEqual([]);
    expect(enabled("api::commerce-maintenance", "commerce-maintenance")).toEqual([]);
  });

  it("grants wallet administration only to Store Manager 2, Finance, Founder, and Superadmin", () => {
    const walletCtrl = (tree: any) =>
      tree["api::local-user-wallet"].controllers["local-user-wallet"];

    const storeManager = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager",
    );
    const founder = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "founder",
    );
    const storeManager2 = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager-2",
    );
    const finance = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "finance",
    );
    const editor = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "editor",
    );
    const superadmin = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "superadmin",
    );

    // Lower management roles retain only their customer-facing wallet action.
    for (const tree of [storeManager, editor]) {
      expect(walletCtrl(tree).getCurrentUserWallet.enabled).toBe(true);
      expect(walletCtrl(tree).adminAdjustWallet.enabled).toBe(false);
      expect(walletCtrl(tree).adminGetUserWallet.enabled).toBe(false);
    }

    expect(walletCtrl(founder).adminAdjustWallet.enabled).toBe(true);
    expect(walletCtrl(founder).adminGetUserWallet.enabled).toBe(true);
    expect(walletCtrl(storeManager2).adminAdjustWallet.enabled).toBe(true);
    expect(walletCtrl(storeManager2).adminGetUserWallet.enabled).toBe(true);
    expect(walletCtrl(storeManager2).adminGetUserWalletHistory.enabled).toBe(true);
    expect(
      storeManager2["api::plugin-user"].controllers["plugin-user"].searchCustomers.enabled,
    ).toBe(true);
    expect(storeManager2["api::report"].controllers.report.productSales.enabled).toBe(false);
    expect(storeManager2["api::admin-user"].controllers["admin-user"].query.enabled).toBe(false);

    expect(walletCtrl(finance).adminAdjustWallet.enabled).toBe(true);
    expect(walletCtrl(finance).adminGetUserWallet.enabled).toBe(true);
    expect(walletCtrl(finance).adminGetUserWalletHistory.enabled).toBe(true);
    expect(
      finance["api::plugin-user"].controllers["plugin-user"].searchCustomers.enabled,
    ).toBe(true);

    // Superadmin (full access) keeps them.
    expect(walletCtrl(superadmin).adminAdjustWallet.enabled).toBe(true);
    expect(walletCtrl(superadmin).adminGetUserWallet.enabled).toBe(true);
  });

  it("creates the initial privileged roles when Strapi has only its default roles", async () => {
    const roles: any[] = [
      { id: 1, name: "Public", type: "public", permissions: [] },
      { id: 2, name: "Authenticated", type: "authenticated", permissions: [] },
    ];
    const persisted = new Map<number, string[]>();
    const roleQuery = {
      findMany: jest.fn(async () => roles),
      findOne: jest.fn(async ({ where }: any) => {
        const role = where.id
          ? roles.find((entry) => entry.id === where.id)
          : roles.find((entry) => entry.name === where.name || entry.type === where.type);
        return role
          ? {
              ...role,
              permissions: (persisted.get(role.id) || role.permissions || []).map((action) =>
                typeof action === "string" ? { action } : action,
              ),
            }
          : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const role = roles.find((entry) => entry.id === where.id);
        if (!role) return null;
        Object.assign(role, data);
        return { ...role };
      }),
      create: jest.fn(async ({ data }: any) => {
        const role = {
          id: Math.max(...roles.map((entry) => entry.id)) + 1,
          permissions: [],
          ...data,
        };
        roles.push(role);
        return role;
      }),
    };
    const userQuery = {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
    };
    const roleService = {
      updateRole: jest.fn(async (roleId: number, { permissions }: any) => {
        const enabledActions: string[] = [];
        for (const [typeKey, typeEntry] of Object.entries(permissions) as any) {
          for (const [controllerName, controller] of Object.entries(typeEntry.controllers) as any) {
            for (const [actionName, value] of Object.entries(controller) as any) {
              if (value.enabled) enabledActions.push(`${typeKey}.${controllerName}.${actionName}`);
            }
          }
        }
        persisted.set(roleId, enabledActions.sort());
      }),
    };
    const permissionsService = {
      getActions: jest.fn(({ defaultEnable }: { defaultEnable: boolean }) => {
        const tree = createActionTree();
        Object.values(tree).forEach((entry: any) => {
          Object.values(entry.controllers).forEach((controller: any) => {
            Object.values(controller).forEach((action: any) => {
              action.enabled = defaultEnable;
            });
          });
        });
        return tree;
      }),
    };
    const snapshots = new Map<string, unknown>();
    const strapi = {
      log: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
      query: jest.fn((uid: string) =>
        uid === "plugin::users-permissions.user" ? userQuery : roleQuery,
      ),
      plugin: jest.fn(() => ({
        service: jest.fn((name: string) => (name === "role" ? roleService : permissionsService)),
      })),
      store: jest.fn(() => ({
        get: jest.fn(async ({ key }: { key: string }) => snapshots.get(key)),
        set: jest.fn(async ({ key, value }: { key: string; value: unknown }) => {
          snapshots.set(key, value);
        }),
      })),
    };

    await expect(
      __rolePermissionTestUtils.ensurePluginRolesAndPermissions(strapi as any),
    ).resolves.toBeUndefined();

    expect(roles.map((role) => role.type)).toEqual(
      expect.arrayContaining([
        "superadmin",
        "editor",
        "seller-1",
        "seller-2",
        "store-manager",
        "store-manager-2",
        "finance",
        "founder",
        "customer",
      ]),
    );
  });

  it("restores the exact pre-sync role state when an operational role cannot be synchronized", async () => {
    const roles = [
      {
        id: 1,
        name: "Superadmin",
        type: "superadmin",
        description: "legacy superadmin",
        permissions: [{ action: "api::product.product.find" }],
      },
      {
        id: 2,
        name: "Store manager",
        type: "store-manager",
        description: "legacy store manager",
        permissions: [{ action: "api::product.product.findOne" }],
      },
    ];
    const users = [
      { id: 10, blocked: false, IsActive: true, role: { id: 1 } },
      { id: 11, blocked: false, IsActive: true, role: { id: 2 } },
    ];
    const persisted = new Map<number, string[]>([
      [1, ["api::product.product.find"]],
      [2, ["api::product.product.findOne"]],
    ]);
    const roleQuery = {
      findMany: jest.fn(async () => roles),
      findOne: jest.fn(async ({ where }: any) => {
        if (where.id) {
          const role = roles.find((entry) => entry.id === where.id);
          return role
            ? {
                ...role,
                permissions: (persisted.get(role.id) || []).map((actionName) => ({
                  action: actionName,
                })),
              }
            : null;
        }
        return roles.find((entry) => entry.name === where.name || entry.type === where.type);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const role = roles.find((entry) => entry.id === where.id);
        if (!role) return null;
        Object.assign(role, data);
        return { ...role };
      }),
      create: jest.fn(async ({ data }: any) => {
        const role = {
          id: Math.max(...roles.map((entry) => entry.id)) + 1,
          permissions: [],
          ...data,
        };
        roles.push(role);
        return role;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const index = roles.findIndex((entry) => entry.id === where.id);
        return index >= 0 ? roles.splice(index, 1)[0] : null;
      }),
    };
    const userQuery = {
      count: jest.fn(async ({ where }: any) => {
        if (!where?.role) return users.length;
        return users.filter(
          (user) =>
            user.role.id === Number(where.role) && user.blocked !== true && user.IsActive !== false,
        ).length;
      }),
      findMany: jest.fn(async () => users),
      findOne: jest.fn(async ({ where }: any) =>
        users.find((user) => user.id === Number(where.id)),
      ),
    };
    let persistenceFailureInjected = false;
    const roleService = {
      updateRole: jest.fn(async (roleId: number, { permissions }: any) => {
        if (roleId === 2 && !persistenceFailureInjected) {
          persistenceFailureInjected = true;
          throw new Error("permission persistence failed");
        }
        const enabledActions: string[] = [];
        for (const [typeKey, typeEntry] of Object.entries(permissions) as any) {
          for (const [controllerName, controller] of Object.entries(typeEntry.controllers) as any) {
            for (const [actionName, value] of Object.entries(controller) as any) {
              if (value.enabled) {
                enabledActions.push(`${typeKey}.${controllerName}.${actionName}`);
              }
            }
          }
        }
        persisted.set(roleId, enabledActions.sort());
      }),
    };
    const permissionsService = {
      getActions: jest.fn(({ defaultEnable }: { defaultEnable: boolean }) => {
        const tree = createActionTree();
        Object.values(tree).forEach((entry: any) => {
          Object.values(entry.controllers).forEach((controller: any) => {
            Object.values(controller).forEach((entryAction: any) => {
              entryAction.enabled = defaultEnable;
            });
          });
        });
        return tree;
      }),
    };
    const storedSnapshots = new Map<string, unknown>();
    const authorizationStore = {
      get: jest.fn(async ({ key }: { key: string }) => storedSnapshots.get(key)),
      set: jest.fn(async ({ key, value }: { key: string; value: unknown }) => {
        storedSnapshots.set(key, value);
      }),
    };
    const strapi = {
      log: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
      query: jest.fn((uid: string) =>
        uid === "plugin::users-permissions.user" ? userQuery : roleQuery,
      ),
      plugin: jest.fn(() => ({
        service: jest.fn((name: string) => (name === "role" ? roleService : permissionsService)),
      })),
      store: jest.fn(() => authorizationStore),
    };

    await expect(
      __rolePermissionTestUtils.ensurePluginRolesAndPermissions(strapi as any),
    ).rejects.toThrow("permission persistence failed");
    expect(roleService.updateRole).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ permissions: expect.any(Object) }),
    );
    expect(roles).toEqual([
      expect.objectContaining({
        id: 1,
        name: "Superadmin",
        type: "superadmin",
        description: "legacy superadmin",
      }),
      expect.objectContaining({
        id: 2,
        name: "Store manager",
        type: "store-manager",
        description: "legacy store manager",
      }),
    ]);
    expect(persisted.get(1)).toEqual(["api::product.product.find"]);
    expect(persisted.get(2)).toEqual(["api::product.product.findOne"]);
    expect(users.map((user) => [user.id, user.role.id])).toEqual([
      [10, 1],
      [11, 2],
    ]);
    expect(storedSnapshots.get("admin-capability-v1-initial-snapshot")).toEqual(
      storedSnapshots.get("admin-capability-v1-latest-pre-sync"),
    );
  });
});
