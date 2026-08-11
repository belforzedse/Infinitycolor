import fs from "fs";
import path from "path";

import contractLifecycle from "../../api/contract/content-types/contract/lifecycles";
import orderItemLifecycle from "../../api/order-item/content-types/order-item/lifecycles";
import orderLifecycle from "../../api/order/content-types/order/lifecycles";
import productStockLifecycle from "../../api/product-stock/content-types/product-stock/lifecycles";
import { recordAdminAudit } from "../../utils/adminAudit";
import { logAdminEvent, logOrderEvent } from "../../utils/eventLogger";
import { registerAppLifecycles } from "../registerAppLifecycles";
import {
  notifyOrderCreatedSms,
  notifyOrderStatusSms,
  notifyShipmentTrackingSms,
} from "../../services/sms";

jest.mock("../../utils/audit", () => ({
  resolveAuditActor: jest.fn(() => ({
    userId: 42,
    label: "Admin User",
    ip: "127.0.0.1",
    userAgent: "jest",
  })),
}));

jest.mock("../../utils/adminAudit", () => ({
  recordAdminAudit: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../utils/eventLogger", () => ({
  logOrderEvent: jest.fn(),
  logAdminEvent: jest.fn(),
}));

jest.mock("../../services/sms", () => ({
  notifyOrderCreatedSms: jest.fn().mockResolvedValue({ ok: true }),
  notifyOrderStatusSms: jest.fn().mockResolvedValue({ ok: true }),
  notifyShipmentTrackingSms: jest.fn().mockResolvedValue({ ok: true }),
}));

function createMockStrapi() {
  const subscribers: any[] = [];
  const update = jest.fn().mockResolvedValue(1);
  const where = jest.fn(() => ({ update }));
  const connection = jest.fn(() => ({ where }));
  (connection as any).raw = jest.fn();

  const queryMocks: Record<string, any> = {
    "api::contract.contract": {
      findOne: jest.fn().mockResolvedValue({ order: { id: 777 } }),
    },
    "api::product-variation.product-variation": {
      findOne: jest.fn().mockResolvedValue({ product: { id: 888 } }),
    },
    "api::order-item.order-item": {
      findOne: jest.fn().mockResolvedValue({ order: { id: 999 } }),
    },
  };
  const activityService = {
    logOrderPlaced: jest.fn(),
    logOrderShipped: jest.fn(),
    logOrderDelivered: jest.fn(),
    logOrderCancelled: jest.fn(),
  };

  const strapi = {
    db: {
      lifecycles: {
        subscribe: jest.fn((subscriber: any) => subscribers.push(subscriber)),
      },
      connection,
      query: jest.fn((uid: string) => queryMocks[uid]),
    },
    entityService: {
      create: jest.fn().mockResolvedValue({ id: 1 }),
      findOne: jest.fn(),
    },
    service: jest.fn(() => activityService),
    log: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    },
  } as any;

  return { strapi, subscribers, activityService, connection, update };
}

function getSubscriber(subscribers: any[], uid: string) {
  const subscriber = subscribers.find((entry) => entry.models?.includes(uid));
  if (!subscriber) throw new Error(`Subscriber not registered for ${uid}`);
  return subscriber;
}

describe("registerAppLifecycles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).strapi;
  });

  it("registers bootstrap subscribers for checkout-related models", () => {
    const { strapi, subscribers } = createMockStrapi();

    registerAppLifecycles(strapi);

    expect(subscribers.map((entry) => entry.models[0])).toEqual([
      "api::order.order",
      "api::contract.contract",
      "api::product-stock.product-stock",
      "api::product.product",
    ]);
  });

  it("restores source timestamps for trusted migration creates and updates", async () => {
    const previousToken = process.env.MIGRATION_CONTROL_TOKEN;
    const controlToken = "t".repeat(48);
    process.env.MIGRATION_CONTROL_TOKEN = controlToken;
    (global as any).strapi = {
      requestContext: {
        get: () => ({
          request: {
            headers: {
              "x-infinity-migration-mode": "wordpress-v2",
              "x-infinity-migration-control": controlToken,
              "x-infinity-source-created-at": "2020-01-02T03:04:05.000Z",
              "x-infinity-source-updated-at": "2024-05-06T07:08:09.000Z",
            },
          },
        }),
      },
    };
    try {
      const { strapi, subscribers } = createMockStrapi();
      registerAppLifecycles(strapi);
      const subscriber = getSubscriber(subscribers, "api::product.product");
      const createEvent: any = { params: { data: { Title: "Imported" } } };
      const updateEvent: any = { params: { data: { Title: "Updated" } } };

      await subscriber.beforeCreate(createEvent);
      await subscriber.beforeUpdate(updateEvent);

      for (const event of [createEvent, updateEvent]) {
        expect(event.params.data.createdAt).toEqual(new Date("2020-01-02T03:04:05.000Z"));
        expect(event.params.data.updatedAt).toEqual(new Date("2024-05-06T07:08:09.000Z"));
      }
    } finally {
      if (previousToken === undefined) delete process.env.MIGRATION_CONTROL_TOKEN;
      else process.env.MIGRATION_CONTROL_TOKEN = previousToken;
      delete (global as any).strapi;
    }
  });

  it("keeps old declarative lifecycle files inert to avoid duplicate handlers", () => {
    expect(orderLifecycle).toEqual({});
    expect(contractLifecycle).toEqual({});
    expect(productStockLifecycle).toEqual({});
    expect(orderItemLifecycle).toEqual({});
  });

  it("guards high-risk declarative lifecycle files against bare global strapi references", () => {
    const lifecycleFiles = [
      "../../api/order/content-types/order/lifecycles.ts",
      "../../api/contract/content-types/contract/lifecycles.ts",
      "../../api/product-stock/content-types/product-stock/lifecycles.ts",
      "../../api/order-item/content-types/order-item/lifecycles.ts",
    ];

    for (const relativeFile of lifecycleFiles) {
      const contents = fs.readFileSync(path.join(__dirname, relativeFile), "utf8");
      expect(contents).not.toMatch(/\bstrapi\./);
    }
  });

  it("keeps technical order effects but leaves canonical audit to the owning mutation", async () => {
    const { strapi, subscribers, activityService } = createMockStrapi();
    strapi.entityService.findOne
      .mockResolvedValueOnce({
        id: 10,
        Status: "Paying",
        Type: "Cart",
        user: { id: 5 },
      })
      .mockResolvedValueOnce({
        id: 10,
        Status: "Shipment",
        Type: "Cart",
        user: { id: 5 },
      });

    registerAppLifecycles(strapi);
    const subscriber = getSubscriber(subscribers, "api::order.order");
    const event = { params: { where: { id: 10 } }, result: { id: 10 }, state: {} };

    await subscriber.beforeUpdate(event);
    await subscriber.afterUpdate(event);

    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::order-log.order-log",
      expect.objectContaining({
        data: expect.objectContaining({
          order: 10,
          Action: "Update",
        }),
      })
    );
    // Lifecycle observers cannot prove who owned the mutation or whether its
    // outer transaction will commit. Canonical events are emitted explicitly by
    // the order service; retaining this call would duplicate and misattribute it.
    expect(recordAdminAudit).not.toHaveBeenCalled();
    expect(logOrderEvent).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        category: "StatusChange",
        orderId: 10,
        oldStatus: "Paying",
        newStatus: "Shipment",
      })
    );
    expect(activityService.logOrderShipped).toHaveBeenCalledWith(5, 10, undefined);
    expect(notifyOrderStatusSms).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        orderId: 10,
        oldStatus: "Paying",
        newStatus: "Shipment",
      })
    );
    expect(logAdminEvent).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        resourceType: "Order",
        resourceId: 10,
        action: "Update",
      })
    );
  });

  it.each([
    ["Paying", "Started"],
    ["Started", "Shipment"],
    ["Shipment", "Done"],
    ["Started", "Cancelled"],
  ])("queues one SMS for %s -> %s order status changes", async (oldStatus, newStatus) => {
    const { strapi, subscribers } = createMockStrapi();
    strapi.entityService.findOne
      .mockResolvedValueOnce({
        id: 11,
        Status: oldStatus,
        Type: "Cart",
        user: { id: 5 },
      })
      .mockResolvedValueOnce({
        id: 11,
        Status: newStatus,
        Type: "Cart",
        user: { id: 5 },
      });

    registerAppLifecycles(strapi);
    const subscriber = getSubscriber(subscribers, "api::order.order");
    const event = { params: { where: { id: 11 } }, result: { id: 11 }, state: {} };

    await subscriber.beforeUpdate(event);
    await subscriber.afterUpdate(event);

    expect(notifyOrderStatusSms).toHaveBeenCalledTimes(1);
    expect(notifyOrderStatusSms).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        orderId: 11,
        oldStatus,
        newStatus,
      })
    );
  });

  it("does not queue status SMS when status is unchanged", async () => {
    const { strapi, subscribers } = createMockStrapi();
    strapi.entityService.findOne
      .mockResolvedValueOnce({
        id: 12,
        Status: "Started",
        ShippingCost: 100,
        user: { id: 5 },
      })
      .mockResolvedValueOnce({
        id: 12,
        Status: "Started",
        ShippingCost: 200,
        user: { id: 5 },
      });

    registerAppLifecycles(strapi);
    const subscriber = getSubscriber(subscribers, "api::order.order");
    const event = { params: { where: { id: 12 } }, result: { id: 12 }, state: {} };

    await subscriber.beforeUpdate(event);
    await subscriber.afterUpdate(event);

    expect(notifyOrderStatusSms).not.toHaveBeenCalled();
  });

  it("queues shipment tracking SMS when ShippingBarcode changes during shipment", async () => {
    const { strapi, subscribers, activityService } = createMockStrapi();
    strapi.entityService.findOne
      .mockResolvedValueOnce({
        id: 13,
        Status: "Shipment",
        ShippingBarcode: null,
        user: { id: 5 },
      })
      .mockResolvedValueOnce({
        id: 13,
        Status: "Shipment",
        ShippingBarcode: "TRACK123",
        user: { id: 5 },
      });

    registerAppLifecycles(strapi);
    const subscriber = getSubscriber(subscribers, "api::order.order");
    const event = { params: { where: { id: 13 } }, result: { id: 13 }, state: {} };

    await subscriber.beforeUpdate(event);
    await subscriber.afterUpdate(event);

    expect(notifyShipmentTrackingSms).toHaveBeenCalledWith(strapi, {
      orderId: 13,
      trackingCode: "TRACK123",
    });
    expect(activityService.logOrderShipped).not.toHaveBeenCalled();
  });

  it("queues order-created SMS after order create", async () => {
    const { strapi, subscribers } = createMockStrapi();

    registerAppLifecycles(strapi);
    const subscriber = getSubscriber(subscribers, "api::order.order");

    await subscriber.afterCreate({
      result: { id: 14, Status: "Paying", Type: "Automatic", user: { id: 5 } },
      state: {},
    });

    expect(notifyOrderCreatedSms).toHaveBeenCalledWith(strapi, 14);
  });

  it("logs contract updates through the gated admin-audit writer", async () => {
    const { strapi, subscribers } = createMockStrapi();
    strapi.entityService.findOne
      .mockResolvedValueOnce({
        id: 20,
        Status: "Pending",
        Amount: 1000,
      })
      .mockResolvedValueOnce({
        id: 20,
        Status: "Cancelled",
        Amount: 1000,
      });

    registerAppLifecycles(strapi);
    const subscriber = getSubscriber(subscribers, "api::contract.contract");
    const event = { params: { where: { id: 20 } }, result: { id: 20 }, state: {} };

    await subscriber.beforeUpdate(event);
    await subscriber.afterUpdate(event);

    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::contract-log.contract-log",
      expect.objectContaining({
        data: expect.objectContaining({
          contract: 20,
          Action: "Update",
        }),
      })
    );
    expect(recordAdminAudit).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        resourceType: "Contract",
        resourceId: 20,
        action: "Update",
      })
    );
  });

  it("logs product-stock deltas once through the bootstrap subscriber", async () => {
    const { strapi, subscribers } = createMockStrapi();
    strapi.entityService.findOne.mockResolvedValueOnce({
      id: 30,
      Count: 2,
      product_variation: { id: 44 },
    });

    registerAppLifecycles(strapi);
    const subscriber = getSubscriber(subscribers, "api::product-stock.product-stock");
    const event = { params: { where: { id: 30 } }, result: { id: 30, Count: 5 }, state: {} };

    await subscriber.beforeUpdate(event);
    await subscriber.afterUpdate(event);

    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::product-stock-log.product-stock-log",
      expect.objectContaining({
        data: expect.objectContaining({
          product_stock: 30,
          Count: 3,
          Type: "Add",
        }),
      })
    );
    expect(recordAdminAudit).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        resourceType: "Stock",
        resourceId: 30,
        action: "Adjust",
      })
    );
  });
});
