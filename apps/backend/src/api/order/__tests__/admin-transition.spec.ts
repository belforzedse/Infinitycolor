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
    request: { body: { status: "Shipment" }, headers: {} },
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

  it("allows the operational Started to Shipment transition and records it", async () => {
    const { strapi, ctx, raw, orderLogCreate } = createHarness("Started");

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(raw).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE orders SET status = ?"),
      ["Shipment", 44, "Started"],
    );
    expect(orderLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        order: 44,
        performed_by: 7,
        Changes: { fromStatus: "Started", toStatus: "Shipment" },
      }),
    }));
    expect(mockedAudit).toHaveBeenCalledWith(
      strapi,
      44,
      { Status: { from: "Started", to: "Shipment" } },
      7,
      null,
      null,
    );
    expect(mockedNotify).toHaveBeenCalledWith(strapi, {
      orderId: 44,
      oldStatus: "Started",
      newStatus: "Shipment",
    });
    expect(strapi.service).toHaveBeenCalledWith("api::user-activity.user-activity");
    expect(strapi.service().logOrderShipped).toHaveBeenCalledWith(9, 44, undefined);
    expect(result).toEqual({ data: { success: true, orderId: 44, status: "Shipment" } });
  });

  it("rejects skipping directly from Started to Done", async () => {
    const { strapi, ctx, raw } = createHarness("Started");
    ctx.request.body.status = "Done";

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(ctx.conflict).toHaveBeenCalledWith(
      "Order status transition is not allowed",
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: "INVALID_ORDER_TRANSITION",
          fromStatus: "Started",
          requestedStatus: "Done",
          allowedStatuses: ["Shipment"],
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

    expect(ctx.forbidden).toHaveBeenCalledWith("Admin access required");
    expect(raw).not.toHaveBeenCalled();
  });

  it("does not apply the new lifecycle transition path to SnappPay orders", async () => {
    const { strapi, ctx, raw } = createHarness(
      "Started",
      "Store manager",
      "SnappPay",
    );

    const result = await adminTransitionOrderHandler(strapi, ctx);

    expect(ctx.conflict).toHaveBeenCalledWith(
      "Use the established SnappPay order update flow",
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: "SNAPPAY_LEGACY_FLOW_REQUIRED",
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ data: expect.any(Object) }),
    }));
    expect(raw).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
    expect(mockedNotify).not.toHaveBeenCalled();
  });
});
