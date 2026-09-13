import { adminTransitionOrderHandler } from "../controllers/helpers/adminTransition";
import { logAdminOrderFieldUpdate } from "../../../utils/adminActivity";
import { notifyOrderStatusSms } from "../../../services/sms/notifications";

jest.mock("../../../utils/adminActivity", () => ({
  logAdminOrderFieldUpdate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../services/sms/notifications", () => ({
  notifyOrderStatusSms: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockedAudit = logAdminOrderFieldUpdate as jest.MockedFunction<
  typeof logAdminOrderFieldUpdate
>;
const mockedNotify = notifyOrderStatusSms as jest.MockedFunction<
  typeof notifyOrderStatusSms
>;

function createHarness(
  status: string,
  roleName = "Store manager",
  paymentGateway = "Mellat",
) {
  const raw = jest.fn().mockResolvedValue({ rows: [{ id: 44 }] });
  const orderLogCreate = jest.fn().mockResolvedValue({ id: 1 });
  const queries: Record<string, any> = {
    "plugin::users-permissions.user": {
      findOne: jest.fn().mockResolvedValue({ id: 7, role: { name: roleName } }),
    },
    "api::order.order": {
      findOne: jest.fn().mockResolvedValue({
        id: 44,
        Status: status,
        PaymentGateway: paymentGateway,
        user: { id: 9 },
      }),
    },
    "api::order-log.order-log": { create: orderLogCreate },
  };
  const strapi = {
    log: { error: jest.fn() },
    query: jest.fn((uid: string) => queries[uid]),
    service: jest.fn().mockReturnValue({
      logOrderShipped: jest.fn().mockResolvedValue(undefined),
      logOrderDelivered: jest.fn().mockResolvedValue(undefined),
    }),
    db: {
      query: jest.fn((uid: string) => queries[uid]),
      transaction: jest.fn(async (callback: any) => callback({ trx: { raw } })),
    },
  } as any;
  const ctx = {
    params: { id: "44" },
    request: { body: { status: "Done" }, headers: {} },
    state: { user: { id: 7 } },
    badRequest: jest.fn(),
    forbidden: jest.fn(),
    notFound: jest.fn(),
    conflict: jest.fn((message: string, payload: any) => ({ message, payload })),
  } as any;
  return { strapi, ctx, raw, orderLogCreate };
}

describe("adminTransitionOrderHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("allows the operational Started to Done transition and records it", async () => {
    const { strapi, ctx, raw, orderLogCreate } = createHarness("Started");

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(raw).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE orders SET status = ?"),
      ["Done", 44, "Started"],
    );
    expect(orderLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        order: 44,
        performed_by: 7,
        Changes: { fromStatus: "Started", toStatus: "Done" },
      }),
    }));
    expect(mockedAudit).toHaveBeenCalledWith(
      strapi,
      44,
      { Status: { from: "Started", to: "Done" } },
      7,
      null,
      null,
      "Store manager",
      expect.objectContaining({ raw: expect.any(Function) }),
    );
    expect(mockedNotify).toHaveBeenCalledWith(strapi, {
      orderId: 44,
      oldStatus: "Started",
      newStatus: "Done",
    });
    // `Done` means prepared, not delivered: it must not log a delivery or a
    // shipment against the customer's activity feed.
    expect(strapi.service().logOrderDelivered).not.toHaveBeenCalled();
    expect(strapi.service().logOrderShipped).not.toHaveBeenCalled();
    expect(result).toEqual({ data: { success: true, orderId: 44, status: "Done" } });
  });

  it("allows Done to Shipment and logs the shipment against the customer", async () => {
    const { strapi, ctx, raw } = createHarness("Done");
    ctx.request.body.status = "Shipment";

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(raw).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE orders SET status = ?"),
      ["Shipment", 44, "Done"],
    );
    expect(strapi.service).toHaveBeenCalledWith("api::user-activity.user-activity");
    expect(strapi.service().logOrderShipped).toHaveBeenCalledWith(9, 44, undefined);
    expect(result).toEqual({ data: { success: true, orderId: 44, status: "Shipment" } });
  });

  it("rejects skipping directly from Started to Shipment", async () => {
    const { strapi, ctx, raw } = createHarness("Started");
    ctx.request.body.status = "Shipment";

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(ctx.conflict).toHaveBeenCalledWith(
      "Order status transition is not allowed",
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: "INVALID_ORDER_TRANSITION",
          fromStatus: "Started",
          requestedStatus: "Shipment",
          allowedStatuses: ["Done"],
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ data: expect.any(Object) }),
    }));
    expect(raw).not.toHaveBeenCalled();
  });

  it("forbids non-operational roles", async () => {
    const { strapi, ctx, raw } = createHarness("Started", "Customer");

    await adminTransitionOrderHandler(strapi, ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith(
      "You do not have permission to perform this action",
    );
    expect(raw).not.toHaveBeenCalled();
  });

  it("uses the standard post-settlement fulfilment lifecycle for SnappPay", async () => {
    const { strapi, ctx, raw } = createHarness(
      "Started",
      "Store manager",
      "SnappPay",
    );

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(raw).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE orders SET status = ?"),
      ["Done", 44, "Started"],
    );
    expect(result).toEqual({
      data: { success: true, orderId: 44, status: "Done" },
    });
    expect(ctx.conflict).not.toHaveBeenCalled();
    expect(mockedAudit).toHaveBeenCalled();
    expect(mockedNotify).toHaveBeenCalled();
  });
});
