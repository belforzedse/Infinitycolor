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
          finalizeToOrder: action(),
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
          update: action(),
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
          delete: action(),
        },
      },
    },
    "api::product-category": {
      controllers: {
        "product-category": {
          find: action(),
          findOne: action(),
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

describe("role permission templates", () => {
  it("keeps store managers away from admin activity and reports", () => {
    const storeManager = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager",
    );

    expect(
      storeManager["api::admin-activity"].controllers["admin-activity"].findOrderActivities
        .enabled,
    ).toBe(false);
    expect(
      storeManager["api::admin-activity"].controllers["admin-activity"].findReport.enabled,
    ).toBe(false);
    expect(storeManager["api::report"].controllers.report.productSales.enabled).toBe(false);
    expect(storeManager["api::report"].controllers.report.trafficDashboard.enabled).toBe(false);
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
    expect(founder["api::commerce-maintenance"].controllers["commerce-maintenance"].purge.enabled).toBe(false);
    expect(founder["api::product-category"].controllers["product-category"].deleteWithReassign.enabled).toBe(false);
    expect(founder["plugin::users-permissions"].controllers.user.find.enabled).toBe(true);
    expect(founder["plugin::users-permissions"].controllers.user.update.enabled).toBe(false);
  });
});
