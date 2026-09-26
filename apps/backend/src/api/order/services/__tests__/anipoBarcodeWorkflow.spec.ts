const mockWriteAuditEvent = jest.fn().mockResolvedValue({
  id: 1,
  eventId: "381576b6-ef74-4a90-b245-c40f06182350",
  deduplicated: false,
});

jest.mock("../../../../audit/writer", () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));
const mockEnqueueAnipoRegistration = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../../queue/anipo-registration", () => ({
  enqueueAnipoRegistration: (...args: unknown[]) => mockEnqueueAnipoRegistration(...args),
}));

import {
  ANIPO_BARCODE_STATES,
  AnipoWorkflowError,
  computeAnipoOrderTotalIrr,
  refreshAnipoBarcodeStatus,
  resolveAnipoPackage,
  processAnipoRegistrationJob,
  runAnipoBarcodeReconciliation,
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
    getOrderBarcodes: jest.fn(async () => ({ ok: true, data: [] })),
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
        package_count: 1,
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

  it("registers queued shipments with fixed 500g/size 3 and accepts an absent immediate barcode", async () => {
    const harness = createHarness(baseOrder({ Status: "Shipment", AnipoBarcodeState: "Pending", AnipoSubmittedAt: null }), { current: null });
    const result = await processAnipoRegistrationJob(harness.strapi, 10, 1, 5);
    expect(result).toMatchObject({ state: "Pending", issued: false });
    expect(harness.anipo.createOrUpdateOrder).toHaveBeenCalledWith(expect.objectContaining({ order_code: "10", weight_g: 500, package_count: 1, box_type: 3, order_total: 9500 }));
    expect(harness.anipo.getOrder).not.toHaveBeenCalled();
    expect(harness.getOrder().AnipoSubmittedAt).toBeInstanceOf(Date);
  });

  it.each([401, 422])("records HTTP %s registration failures for review without retrying", async (status) => {
    const harness = createHarness(baseOrder({ Status: "Shipment", AnipoBarcodeState: "Pending", AnipoSubmittedAt: null }), { current: null });
    harness.anipo.createOrUpdateOrder.mockResolvedValue({ ok: false, status, error: "validation_failed", validationErrors: status === 422 ? { receiver_city: ["شهر نامعتبر است"] } : undefined });
    await expect(processAnipoRegistrationJob(harness.strapi, 10, 1, 5)).resolves.toEqual({ skipped: true });
    expect(harness.getOrder().AnipoBarcodeState).toBe("NeedsAttention");
    if (status === 422) expect(harness.getOrder().AnipoLastError).toContain("receiver_city");
  });

  it("bounds transient registration retries and leaves the failed order visible", async () => {
    const harness = createHarness(baseOrder({ Status: "Shipment", AnipoBarcodeState: "Pending", AnipoSubmittedAt: null }), { current: null });
    harness.anipo.createOrUpdateOrder.mockResolvedValue({ ok: false, status: 429, error: "rate_limited" });
    await expect(processAnipoRegistrationJob(harness.strapi, 10, 1, 5)).rejects.toThrow();
    expect(harness.getOrder().AnipoBarcodeState).toBe("Pending");
    await expect(processAnipoRegistrationJob(harness.strapi, 10, 5, 5)).resolves.toEqual({ skipped: true });
    expect(harness.getOrder().AnipoBarcodeState).toBe("NeedsAttention");
  });

  it("allows an operator to resubmit NeedsAttention with the same order code", async () => {
    const harness = createHarness(baseOrder({ Status: "Shipment", AnipoBarcodeState: "NeedsAttention", AnipoSubmittedAt: null }), { current: null });
    const result = await submitAnipoBarcode(harness.strapi, 10, { forceRetry: true, weight: 500, boxSizeId: 3 });
    expect(result.state).toBe("Pending");
    expect(harness.anipo.createOrUpdateOrder).toHaveBeenCalledWith(expect.objectContaining({ order_code: "10" }));
  });

  it("keeps an authoritative issued result when another registration wins the update", async () => {
    const original = baseOrder({ Status: "Shipment", AnipoBarcodeState: "Pending", AnipoSubmittedAt: null });
    const harness = createHarness(original, { current: null });
    harness.orderQuery.findOne
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({
        ...original,
        AnipoBarcodeState: "Issued",
        AnipoSubmittedAt: new Date(),
        ShippingBarcode: "POST-WINNER",
        AnipoBarcodeData: { expectedCount: 1, barcodes: ["POST-WINNER"] },
      });
    harness.orderQuery.update.mockResolvedValueOnce(null);
    const result = await submitAnipoBarcode(harness.strapi, 10, { weight: 500, boxSizeId: 3 });
    expect(result).toMatchObject({ state: "Issued", barcode: "POST-WINNER" });
    expect(harness.orderQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AnipoSubmittedAt: { $null: true } }),
    }));
    expect(mockWriteAuditEvent).not.toHaveBeenCalled();
  });

  it("keeps polling a partial barcode and stores all issued codes", async () => {
    const harness = createHarness(baseOrder({
      Status: "Shipment",
      AnipoBarcodeState: "Pending",
      AnipoSubmittedAt: new Date("2026-09-25T00:00:00Z"),
      ShippingBarcode: "POST-1",
      AnipoBarcodeData: { expectedCount: 2, barcodes: ["POST-1"] },
    }), { current: { ok: true, data: { issued: true, barcode: "POST-1", barcodes: ["POST-1", "POST-2"], expectedCount: 2 } } });
    const result = await refreshAnipoBarcodeStatus(harness.strapi, 10, { source: "admin" });
    expect(result).toMatchObject({ state: "Issued", barcodes: ["POST-1", "POST-2"], expectedCount: 2 });
    expect(harness.getOrder().AnipoBarcodeData).toEqual({ expectedCount: 2, barcodes: ["POST-1", "POST-2"] });
  });

  it("chunks scheduled barcode polling at 200 and keeps a partial multi-parcel response pending", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({ id: index + 1, Status: "Shipment", AnipoBarcodeState: "Pending", AnipoSubmittedAt: new Date(), AnipoCheckCount: 0 }));
    const updates: Array<{ id: number; data: any }> = [];
    const orderQuery = {
      findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(rows),
      update: jest.fn(async ({ where, data }: any) => { updates.push({ id: where.id, data }); return { id: where.id, ...data }; }),
      findOne: jest.fn(async ({ where }: any) => baseOrder({ id: where.id, Status: "Shipment" })),
    };
    const anipo = {
      getOrderBarcodes: jest.fn(async (codes: string[]) => ({ ok: true, data: codes.map((code) => ({
        orderCode: code, found: true, issued: code === "1", expectedCount: code === "1" ? 2 : 1,
        barcode: code === "1" ? "POST-1" : undefined,
        barcodes: code === "1" ? ["POST-1"] : [],
      })) })),
    };
    const strapi = { db: { query: jest.fn(() => orderQuery) }, service: jest.fn(() => anipo), log: { info: jest.fn(), error: jest.fn() } } as any;
    const originalSize = process.env.ANIPO_BARCODE_RECONCILE_BATCH_SIZE;
    process.env.ANIPO_BARCODE_RECONCILE_BATCH_SIZE = "500";
    try {
      await runAnipoBarcodeReconciliation(strapi);
    } finally {
      if (originalSize === undefined) delete process.env.ANIPO_BARCODE_RECONCILE_BATCH_SIZE;
      else process.env.ANIPO_BARCODE_RECONCILE_BATCH_SIZE = originalSize;
    }
    expect(anipo.getOrderBarcodes.mock.calls.map(([codes]) => codes.length)).toEqual([200, 1]);
    expect(orderQuery.findMany.mock.calls[2][0].where).toMatchObject({
      AnipoBarcodeState: "Pending",
      AnipoSubmittedAt: { $notNull: true },
      $and: [
        { Status: "Shipment" },
        { $or: expect.arrayContaining([{ AnipoPollingDeadlineAt: { $gt: expect.any(Date) } }]) },
      ],
    });
    expect(updates.find((entry) => entry.id === 1)?.data).toMatchObject({
      AnipoBarcodeState: "Pending",
      ShippingBarcode: "POST-1",
      AnipoBarcodeData: { expectedCount: 2, barcodes: ["POST-1"] },
    });
    expect(anipo.getOrderBarcodes).toHaveBeenCalledTimes(2);
  });

  it("moves expired submitted orders to review without calling Anipo", async () => {
    const orderQuery = {
      findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 77 }]).mockResolvedValueOnce([]),
      update: jest.fn().mockResolvedValue({ id: 77 }),
    };
    const anipo = { getOrderBarcodes: jest.fn() };
    const strapi = { db: { query: jest.fn(() => orderQuery) }, service: jest.fn(() => anipo), log: { info: jest.fn(), error: jest.fn() } } as any;
    await runAnipoBarcodeReconciliation(strapi);
    expect(orderQuery.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 77, AnipoBarcodeState: "Pending" }, data: expect.objectContaining({ AnipoBarcodeState: "NeedsAttention" }) }));
    expect(orderQuery.findMany.mock.calls[1][0].where).toMatchObject({
      AnipoSubmittedAt: { $notNull: true },
      $and: [
        { Status: "Shipment" },
        { $or: expect.arrayContaining([{ AnipoPollingDeadlineAt: { $lte: expect.any(Date) } }]) },
      ],
    });
    expect(anipo.getOrderBarcodes).not.toHaveBeenCalled();
  });

  it("marks a provider-missing order for review without affecting another pending result", async () => {
    const rows = [{ id: 1, AnipoCheckCount: 0 }, { id: 2, AnipoCheckCount: 0 }];
    const orderQuery = {
      findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(rows),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    };
    const anipo = { getOrderBarcodes: jest.fn(async () => ({ ok: true, data: [
      { orderCode: "1", found: false, issued: false },
      { orderCode: "2", found: true, issued: false },
    ] })) };
    const strapi = { db: { query: jest.fn(() => orderQuery) }, service: jest.fn(() => anipo), log: { info: jest.fn(), error: jest.fn() } } as any;
    const result = await runAnipoBarcodeReconciliation(strapi);
    expect(result).toMatchObject({ stats: { processed: 2, needsAttention: 1 } });
    expect(orderQuery.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1, AnipoBarcodeState: "Pending" }, data: expect.objectContaining({ AnipoBarcodeState: "NeedsAttention", AnipoLastError: "ANIPO_REMOTE_ORDER_NOT_FOUND" }) }));
    expect(orderQuery.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 2, AnipoBarcodeState: "Pending" }, data: expect.objectContaining({ AnipoBarcodeState: "Pending" }) }));
  });

  it("requeues committed unsubmitted shipments during the existing reconciliation tick", async () => {
    const orderQuery = {
      findMany: jest.fn().mockResolvedValueOnce([{ id: 44 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]),
    };
    const strapi = { db: { query: jest.fn(() => orderQuery) }, log: { info: jest.fn(), error: jest.fn() } } as any;
    mockEnqueueAnipoRegistration.mockClear();
    await runAnipoBarcodeReconciliation(strapi);
    expect(mockEnqueueAnipoRegistration).toHaveBeenCalledWith(44);
  });

  it("continues storing successful batch results after another row fails", async () => {
    const rows = [{ id: 1, AnipoCheckCount: 0 }, { id: 2, AnipoCheckCount: 0 }];
    const orderQuery = {
      findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(rows),
      update: jest.fn(async ({ where, data }: any) => {
        if (where.id === 1) throw new Error("row failed");
        return { id: where.id, ...data };
      }),
    };
    const anipo = { getOrderBarcodes: jest.fn(async () => ({ ok: true, data: rows.map((row) => ({ orderCode: String(row.id), found: true, issued: false })) })) };
    const strapi = { db: { query: jest.fn(() => orderQuery) }, service: jest.fn(() => anipo), log: { info: jest.fn(), error: jest.fn() } } as any;
    const result = await runAnipoBarcodeReconciliation(strapi);
    expect(result).toMatchObject({ stats: { processed: 1, failed: 1 } });
    expect(orderQuery.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 2, AnipoBarcodeState: "Pending" } }));
  });
});
