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
    "api::report": {
      controllers: {
        report: {
          productSales: action(),
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
  it("gives founders the same generated permissions as store managers", () => {
    const storeManager = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "store-manager",
    );
    const founder = __rolePermissionTestUtils.getDefaultPermissions(
      createStrapiForPermissions() as any,
      "founder",
    );

    expect(founder).toEqual(storeManager);
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
