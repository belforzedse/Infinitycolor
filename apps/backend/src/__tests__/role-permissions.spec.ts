jest.mock("@sentry/node", () => ({ init: jest.fn() }));
jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    connect: jest.fn().mockResolvedValue({}),
  })),
}));
jest.unmock("../index");

import { __rolePermissionTestUtils } from "../index";

function action(enabled = false) {
  return { enabled };
}

function createActionTree() {
  return {
    "api::cart": {
      controllers: {
        cart: {
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
          generateVariationCombinations: action(),
          delete: action(),
        },
      },
    },
    "api::product-category-content": {
      controllers: {
        "product-category-content": {
          find: action(),
          findOne: action(),
          create: action(),
          update: action(),
          delete: action(),
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
          verifyPayment: action(),
          adminAdjustItems: action(),
          adminUpdateNotes: action(),
          adminTransition: action(),
          adminCancel: action(),
          adminPaymentOperation: action(),
          adminVoidBarcode: action(),
          generateAnipoBarcode: action(),
          decrementStockManual: action(),
        },
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
  it("keeps store managers away from admin activity and reports", () => {
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
    expect(storeManager["api::report"].controllers.report.trafficDashboard.enabled).toBe(false);
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

  it("allows founders to read order-scoped admin activity but not standalone activity reports", () => {
    const founder = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "founder",
    );

    const adminActivity = founder["api::admin-activity"].controllers["admin-activity"];
    expect(adminActivity.findOrderActivities.enabled).toBe(true);
    expect(adminActivity.find.enabled).toBe(false);
    expect(adminActivity.findOne.enabled).toBe(false);
    expect(adminActivity.findReport.enabled).toBe(false);
    expect(adminActivity.findUserActivities.enabled).toBe(false);
    expect(adminActivity.findProductActivities.enabled).toBe(false);
  });

  it("allows founders to use sales reports without traffic or admin-activity reports", () => {
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
    expect(report.liquidity.enabled).toBe(false);
    expect(report.gatewayLiquidity.enabled).toBe(false);
    expect(report.adminActivity.enabled).toBe(false);
    expect(report.adminActivityById.enabled).toBe(false);
    expect(report.trafficDashboard.enabled).toBe(false);
    expect(report.trafficRealtime.enabled).toBe(false);
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
      founder["api::product-category"].controllers["product-category"].deleteWithReassign.enabled,
    ).toBe(false);
    expect(founder["plugin::users-permissions"].controllers.user.find.enabled).toBe(false);
    expect(founder["plugin::users-permissions"].controllers.user.update.enabled).toBe(false);
  });

  it("grants the complete operational commerce matrix without raw financial or master deletion", () => {
    const storeManager = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager",
    );
    const controller = (typeKey: string, name: string) => storeManager[typeKey].controllers[name];

    expect(controller("api::product", "product").generateVariationCombinations.enabled).toBe(true);
    expect(controller("api::product-variation", "product-variation").delete.enabled).toBe(true);
    expect(controller("api::product-stock", "product-stock").create.enabled).toBe(true);
    expect(controller("api::product-stock", "product-stock").update.enabled).toBe(true);
    expect(controller("api::product-stock", "product-stock").delete.enabled).toBe(false);

    for (const [typeKey, name] of [
      ["api::product-category-content", "product-category-content"],
      ["api::product-faq", "product-faq"],
      ["api::product-size-helper", "product-size-helper"],
    ]) {
      expect(controller(typeKey, name).create.enabled).toBe(true);
      expect(controller(typeKey, name).update.enabled).toBe(true);
      expect(controller(typeKey, name).delete.enabled).toBe(true);
    }

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

    expect(
      controller("api::product-attribute-assignment", "product-attribute-assignment").delete
        .enabled,
    ).toBe(true);
    expect(controller("api::discount", "discount").create.enabled).toBe(true);
    expect(controller("api::discount", "discount").update.enabled).toBe(true);
    expect(controller("api::discount", "discount").delete.enabled).toBe(false);
    expect(controller("api::general-discount", "general-discount").create.enabled).toBe(true);
    expect(controller("api::shipping", "shipping").create.enabled).toBe(true);
    expect(controller("api::shipping", "shipping").delete.enabled).toBe(false);
    expect(controller("api::shipping-province", "shipping-province").update.enabled).toBe(false);
    expect(controller("api::shipping-city", "shipping-city").create.enabled).toBe(false);

    const order = controller("api::order", "order");
    expect(order.find.enabled).toBe(true);
    expect(order.adminAdjustItems.enabled).toBe(true);
    expect(order.adminUpdateNotes.enabled).toBe(true);
    expect(order.adminTransition.enabled).toBe(true);
    expect(order.create.enabled).toBe(false);
    expect(order.update.enabled).toBe(false);
    expect(order.delete.enabled).toBe(false);
    expect(order.adminPaymentOperation.enabled).toBe(false);

    expect(controller("api::plugin-user", "plugin-user").searchCustomers.enabled).toBe(true);
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

    expect(enabled("api::product", "product")).toEqual([
      "create",
      "find",
      "findOne",
      "generateVariationCombinations",
      "search",
      "update",
    ]);
    expect(enabled("api::product-category", "product-category")).toEqual([
      "create",
      "find",
      "findOne",
      "update",
    ]);
    expect(enabled("api::product-variation", "product-variation")).toEqual([
      "create",
      "delete",
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
    expect(enabled("api::discount", "discount")).toEqual(["create", "find", "findOne", "update"]);
    expect(enabled("api::general-discount", "general-discount")).toEqual([
      "create",
      "find",
      "findOne",
      "update",
    ]);
    expect(enabled("api::shipping", "shipping")).toEqual(["create", "find", "findOne", "update"]);
    expect(enabled("api::shipping-province", "shipping-province")).toEqual(["find", "findOne"]);
    expect(enabled("api::shipping-city", "shipping-city")).toEqual(["find", "findOne"]);
    expect(enabled("api::order", "order")).toEqual([
      "adminAdjustItems",
      "adminCancel",
      "adminTransition",
      "adminUpdateNotes",
      "adminVoidBarcode",
      "checkPaymentStatus",
      "decrementStockManual",
      "find",
      "findOne",
      "generateAnipoBarcode",
      "getActiveReserve",
      "getMyOrderDetail",
      "getMyOrders",
      "reconcilePayment",
      "releaseReserve",
      "verifyPayment",
    ]);
    expect(enabled("api::product-review", "product-review")).toEqual([
      "find",
      "findOne",
      "getUserReviews",
      "submitReview",
      "update",
    ]);
    expect(enabled("api::product-review-reply", "product-review-reply")).toEqual([
      "create",
      "delete",
      "find",
      "findOne",
      "update",
    ]);
    expect(enabled("plugin::upload", "content-api")).toEqual(["find", "findOne", "upload"]);
    expect(enabled("api::payment-gateway", "payment-gateway")).toEqual([
      "availableGateways",
      "snappEligible",
    ]);
    expect(enabled("api::wallet-topup", "wallet-topup")).toEqual([
      "chargeIntent",
      "paymentCallback",
    ]);
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

  it("restricts admin wallet management to superadmin only", () => {
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
    const editor = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "editor",
    );
    const superadmin = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "superadmin",
    );

    // Non-superadmin management roles retain only their customer-facing wallet action.
    for (const tree of [storeManager, founder, editor]) {
      expect(walletCtrl(tree).getCurrentUserWallet.enabled).toBe(true);
      expect(walletCtrl(tree).adminAdjustWallet.enabled).toBe(false);
      expect(walletCtrl(tree).adminGetUserWallet.enabled).toBe(false);
    }

    // Superadmin (full access) keeps them.
    expect(walletCtrl(superadmin).adminAdjustWallet.enabled).toBe(true);
    expect(walletCtrl(superadmin).adminGetUserWallet.enabled).toBe(true);
  });

  it("fails bootstrap when an operational role cannot be synchronized", async () => {
    const roles = [
      { id: 1, name: "Superadmin", type: "superadmin" },
      { id: 2, name: "Store manager", type: "store-manager" },
    ];
    const persisted = new Map<number, string[]>();
    const roleQuery = {
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
      update: jest.fn(async ({ where, data }: any) => ({
        ...roles.find((entry) => entry.id === where.id),
        ...data,
      })),
      create: jest.fn(),
    };
    const roleService = {
      updateRole: jest.fn(async (roleId: number, { permissions }: any) => {
        if (roleId === 2) throw new Error("permission persistence failed");
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
    const strapi = {
      log: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
      query: jest.fn(() => roleQuery),
      plugin: jest.fn(() => ({
        service: jest.fn((name: string) => (name === "role" ? roleService : permissionsService)),
      })),
    };

    await expect(
      __rolePermissionTestUtils.ensurePluginRolesAndPermissions(strapi as any),
    ).rejects.toThrow("permission persistence failed");
    expect(roleService.updateRole).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ permissions: expect.any(Object) }),
    );
  });
});
