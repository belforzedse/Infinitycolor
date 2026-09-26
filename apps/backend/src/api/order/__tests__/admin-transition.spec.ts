import { adminTransitionOrderHandler } from "../controllers/helpers/adminTransition";
import { logAdminOrderFieldUpdate } from "../../../utils/adminActivity";
import { notifyOrderStatusSms } from "../../../services/sms/notifications";
import { enqueueAnipoRegistration } from "../../../queue/anipo-registration";

jest.mock("../../../utils/adminActivity", () => ({
  logAdminOrderFieldUpdate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../services/sms/notifications", () => ({
  notifyOrderStatusSms: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../../../queue/anipo-registration", () => ({
  enqueueAnipoRegistration: jest.fn().mockResolvedValue(undefined),
}));

const mockedAudit = logAdminOrderFieldUpdate as jest.MockedFunction<
  typeof logAdminOrderFieldUpdate
>;
const mockedNotify = notifyOrderStatusSms as jest.MockedFunction<
  typeof notifyOrderStatusSms
>;
const mockedEnqueue = enqueueAnipoRegistration as jest.MockedFunction<typeof enqueueAnipoRegistration>;

function createHarness(
  status: string,
  roleName = "Store manager",
  paymentGateway = "Mellat",
  shippingMethodCode?: string,
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
        ShippingMethodCode: shippingMethodCode,
        user: { id: 9 },
      }),
      update: jest.fn().mockResolvedValue({ id: 44 }),
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

  it("atomically records Done then Shipment and enqueues postal registration", async () => {
    const { strapi, ctx, raw, orderLogCreate } = createHarness("Started", "Store manager", "Mellat", "post");

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(raw).toHaveBeenCalledTimes(3);
    expect(raw).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE orders SET status = ?"),
      ["Done", 44, "Started"],
    );
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("UPDATE orders SET status = ?"), ["Shipment", 44, "Done"]);
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("anipo_barcode_state = 'Pending'"), [44]);
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
    expect(mockedNotify).toHaveBeenCalledTimes(1);
    expect(mockedNotify).toHaveBeenCalledWith(strapi, {
      orderId: 44,
      oldStatus: "Started",
      newStatus: "Shipment",
    });
    expect(strapi.service().logOrderDelivered).not.toHaveBeenCalled();
    expect(strapi.service().logOrderShipped).toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalledWith(44);
    expect(result).toEqual({ data: { success: true, orderId: 44, status: "Shipment" } });
  });

  it("keeps the committed Shipment recoverable if enqueueing fails", async () => {
    const { strapi, ctx, raw } = createHarness("Started", "Store manager", "Mellat", "post");
    mockedEnqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    const result = await adminTransitionOrderHandler(strapi, ctx);
    expect(result).toEqual({ data: { success: true, orderId: 44, status: "Shipment" } });
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("anipo_barcode_state = 'Pending'"), [44]);
    expect(strapi.log.error).toHaveBeenCalledWith("Anipo registration enqueue failed", expect.objectContaining({ orderId: 44 }));
  });

  it("leaves a reserved order Started during its 48-hour hold", async () => {
    const { strapi, ctx, raw } = createHarness("Started");
    strapi.db.query("api::order.order").findOne
      .mockResolvedValueOnce({
        id: 44,
        Status: "Started",
        PaymentGateway: "Mellat",
        user: { id: 9 },
        reserve_shipment: { State: "Active" },
      })
      .mockResolvedValueOnce({ id: 44, reserve_shipment: { State: "Active" } });

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(raw).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(strapi.service().logOrderShipped).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ payload: expect.objectContaining({ data: expect.objectContaining({ errorCode: "RESERVE_HOLD_ACTIVE" }) }) }));
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

  it("does not enqueue again for a repeated Shipment update", async () => {
    const { strapi, ctx, raw } = createHarness("Shipment", "Store manager", "Mellat", "post");
    ctx.request.body.status = "Shipment";
    expect(await adminTransitionOrderHandler(strapi, ctx)).toEqual({ data: { success: true, orderId: 44, status: "Shipment", unchanged: true } });
    expect(raw).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("refuses Done to Shipment while a reserve hold is active", async () => {
    const { strapi, ctx, raw } = createHarness("Done");
    ctx.request.body.status = "Shipment";
    const orderQuery = strapi.db.query("api::order.order");
    orderQuery.findOne
      .mockResolvedValueOnce({ id: 44, Status: "Done", PaymentGateway: "Mellat", user: { id: 9 } })
      .mockResolvedValueOnce({
        id: 44,
        reserve_shipment: { State: "Active", groupKey: "rg-1", expiresAt: "2026-09-18T00:00:00.000Z" },
      });

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(ctx.conflict).toHaveBeenCalledWith(
      "سفارش در مهلت رزرو ۴۸ ساعته است و هنوز قابل تکمیل و ارسال نیست",
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: "RESERVE_HOLD_ACTIVE",
          reserveGroupId: "rg-1",
        }),
      }),
    );
    expect(raw).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ data: expect.any(Object) }),
    }));
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

    expect(raw).toHaveBeenCalledTimes(2);
    expect(raw).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE orders SET status = ?"),
      ["Done", 44, "Started"],
    );
    expect(result).toEqual({
      data: { success: true, orderId: 44, status: "Shipment" },
    });
    expect(ctx.conflict).not.toHaveBeenCalled();
    expect(mockedAudit).toHaveBeenCalled();
    expect(mockedNotify).toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});
