const mockWriteAuditEvent = jest.fn().mockResolvedValue({
  id: 1,
  eventId: "381576b6-ef74-4a90-b245-c40f06182350",
  deduplicated: false,
});

jest.mock("../../../../audit/writer", () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));

import {
  ANIPO_BARCODE_STATES,
  AnipoWorkflowError,
  computeAnipoOrderTotalIrr,
  refreshAnipoBarcodeStatus,
  resolveAnipoPackage,
  submitAnipoBarcode,
} from "../anipoBarcodeWorkflow";

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    Status: "Started",
    ShippingMethodCode: "post",
    ShippingBarcode: null,
    ShippingWeight: 0,
    ShippingBoxSizeId: 0,
    AppliedDiscountAmount: 0,
    ShippingCost: 50,
    contract: { Amount: 950 },
    user: {
      phone: "09121234567",
      user_info: { FirstName: "زهرا", LastName: "محمدی" },
    },
    delivery_address: {
      FullAddress: "خیابان ولیعصر، پلاک ۱۲",
      PostalCode: "1234567890",
      shipping_city: {
        Title: "تهران",
        shipping_province: { Title: "تهران" },
      },
    },
    order_items: [
      {
        Count: 2,
        PerAmount: 500,
        product_variation: { product: { Weight: 200 } },
      },
    ],
    ...overrides,
  };
}

function createHarness(initialOrder: any, provider: any) {
  let order = { ...initialOrder };
  const updates: any[] = [];
  const orderQuery = {
    findOne: jest.fn(async () => ({ ...order })),
    update: jest.fn(async ({ data }: any) => {
      updates.push(data);
      order = { ...order, ...data };
      return { ...order };
    }),
    findMany: jest.fn(async () => []),
  };
  const orderLogQuery = { create: jest.fn(async () => ({})) };
  const anipo = {
    createOrUpdateOrder: jest.fn(async () => ({ ok: true, data: {} })),
    getOrder: jest.fn(async () => provider.current),
  };
  const strapi = {
    db: {
      query: jest.fn((uid: string) =>
        uid === "api::order.order" ? orderQuery : orderLogQuery,
      ),
      transaction: jest.fn(async (callback: any) => callback({ trx: {} })),
    },
    service: jest.fn(() => anipo),
    log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  } as any;
  return { strapi, anipo, orderQuery, orderLogQuery, updates, getOrder: () => order };
}

describe("Anipo barcode workflow", () => {
  beforeEach(() => mockWriteAuditEvent.mockClear());

  it("sends the payable contract amount in IRR", () => {
    expect(computeAnipoOrderTotalIrr(baseOrder())).toBe(9_500);
    expect(
      computeAnipoOrderTotalIrr(
        baseOrder({
          contract: null,
          AppliedDiscountAmount: 100,
          ShippingCost: 50,
        }),
      ),
    ).toBe(9_500);
  });

  it("uses request, stored, then computed package data and validates provider ranges", () => {
    expect(resolveAnipoPackage(baseOrder(), { weight: 700, boxSizeId: 4 })).toEqual({
      weight: 700,
      boxSizeId: 4,
    });
    expect(
      resolveAnipoPackage(baseOrder({ ShippingWeight: 650, ShippingBoxSizeId: 2 }), {}),
    ).toEqual({ weight: 650, boxSizeId: 2 });
    expect(resolveAnipoPackage(baseOrder(), {})).toEqual({ weight: 400, boxSizeId: 3 });
    expect(() => resolveAnipoPackage(baseOrder(), { boxSizeId: 11 })).toThrow(
      AnipoWorkflowError,
    );
  });

  it("persists pending, does not resubmit, then stores an issued barcode without completing the order", async () => {
    const provider: { current: any } = {
      current: {
        ok: true,
        data: { issued: false, readyToIssue: true, status: "pending_operator" },
      },
    };
    const harness = createHarness(baseOrder(), provider);
    const now = new Date("2026-08-11T09:00:00.000Z");

    const submitted = await submitAnipoBarcode(harness.strapi, 10, { now });

    expect(submitted).toMatchObject({
      state: ANIPO_BARCODE_STATES.pending,
      issued: false,
      pending: true,
    });
    expect(harness.anipo.createOrUpdateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        order_code: "10",
        weight_g: 400,
        box_type: 3,
        order_total: 9_500,
      }),
    );

    const repeated = await submitAnipoBarcode(harness.strapi, 10, { now });
    expect(repeated.already).toBe(true);
    expect(harness.anipo.createOrUpdateOrder).toHaveBeenCalledTimes(1);

    provider.current = {
      ok: true,
      data: {
        issued: true,
        barcode: "POST-123",
        status: "issued",
        issuedAt: "2026-08-11T09:15:00.000Z",
      },
    };
    const refreshed = await refreshAnipoBarcodeStatus(harness.strapi, 10, {
      source: "scheduler",
      now: new Date("2026-08-11T09:15:00.000Z"),
    });

    expect(refreshed).toMatchObject({
      state: ANIPO_BARCODE_STATES.issued,
      issued: true,
      barcode: "POST-123",
    });
    expect(harness.getOrder()).toMatchObject({
      Status: "Started",
      ShippingBarcode: "POST-123",
      AnipoBarcodeState: ANIPO_BARCODE_STATES.issued,
    });
    expect(harness.updates.every((update) => !("Status" in update))).toBe(true);
    expect(harness.orderLogQuery.create).not.toHaveBeenCalled();
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      harness.strapi,
      expect.objectContaining({
        actor: expect.objectContaining({ type: "scheduled_job" }),
        initiator: expect.objectContaining({ type: "scheduled_job" }),
        origin: "scheduled_task",
        target: expect.objectContaining({ type: "order", id: 10 }),
      }),
    );
  });

  it("stops automatic checks after the seven-day deadline but permits later manual checks", async () => {
    const provider: { current: any } = {
      current: { ok: true, data: { issued: false, status: "pending_operator" } },
    };
    const harness = createHarness(
      baseOrder({
        AnipoBarcodeState: ANIPO_BARCODE_STATES.pending,
        AnipoPollingDeadlineAt: "2026-08-10T09:00:00.000Z",
      }),
      provider,
    );

    const expired = await refreshAnipoBarcodeStatus(harness.strapi, 10, {
      source: "scheduler",
      now: new Date("2026-08-11T09:00:00.000Z"),
    });
    expect(expired.state).toBe(ANIPO_BARCODE_STATES.needsAttention);
    expect(harness.anipo.getOrder).not.toHaveBeenCalled();

    const manual = await refreshAnipoBarcodeStatus(harness.strapi, 10, {
      source: "admin",
      now: new Date("2026-08-11T09:05:00.000Z"),
    });
    expect(manual.state).toBe(ANIPO_BARCODE_STATES.needsAttention);
    expect(harness.anipo.getOrder).toHaveBeenCalledTimes(1);
  });
});
