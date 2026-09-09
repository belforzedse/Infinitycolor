import {
  activateGroupOnPayment,
  claimGroupShippingBarcode,
  findGroupShippingBarcode,
  closeGroup,
  closeGroupIfAbandoned,
  computeReserveDeadline,
  confirmReservePaymentForOrder,
  hasPaidMember,
  isOrderHeldByReserve,
  projectOrderReserve,
  RESERVE_CLOSURE_REASONS,
  RESERVE_GROUP_STATES,
  resolveRetainedReserveShipping,
} from "../lib/reserve-group";

function createStrapi(overrides: Record<string, any> = {}) {
  const orderQuery = {
    findOne: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn().mockResolvedValue({}),
  };
  const groupQuery = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  };
  const raw = jest.fn().mockResolvedValue({ rows: [] });
  const strapi = {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    db: {
      connection: { raw },
      query: jest.fn((uid: string) => {
        if (uid === "api::order.order") return orderQuery;
        return groupQuery;
      }),
    },
    ...overrides,
  } as any;
  return { strapi, orderQuery, groupQuery, raw };
}

describe("reserve group lifecycle", () => {
  afterEach(() => jest.clearAllMocks());

  describe("activation", () => {
    it("starts the 48h window at payment, not at checkout", async () => {
      const { strapi, raw } = createStrapi();
      raw.mockResolvedValueOnce({ rows: [{ id: 5 }] });
      const now = new Date("2026-09-09T10:00:00.000Z");

      const result = await activateGroupOnPayment(strapi, {
        groupId: 5,
        orderId: 1,
        shippingCostPaid: 45_000,
        now,
      });

      expect(result.activated).toBe(true);
      expect(result.expiresAt?.toISOString()).toBe("2026-09-11T10:00:00.000Z");
      // CAS-guarded on PendingActivation: duplicate callbacks cannot re-open it.
      expect(raw.mock.calls[0][1]).toContain(RESERVE_GROUP_STATES.pendingActivation);
    });

    it("is a no-op when the group was already activated", async () => {
      const { strapi, raw } = createStrapi();
      raw.mockResolvedValueOnce({ rows: [] });

      const result = await activateGroupOnPayment(strapi, {
        groupId: 5,
        orderId: 1,
        shippingCostPaid: 0,
      });

      expect(result.activated).toBe(false);
      expect(result.expiresAt).toBeNull();
    });

    it("honours RESERVE_ORDER_WINDOW_HOURS but defaults to 48", () => {
      const from = new Date("2026-09-09T00:00:00.000Z");
      expect(computeReserveDeadline(from).toISOString()).toBe("2026-09-11T00:00:00.000Z");

      process.env.RESERVE_ORDER_WINDOW_HOURS = "24";
      expect(computeReserveDeadline(from).toISOString()).toBe("2026-09-10T00:00:00.000Z");
      process.env.RESERVE_ORDER_WINDOW_HOURS = "not-a-number";
      expect(computeReserveDeadline(from).toISOString()).toBe("2026-09-11T00:00:00.000Z");
      delete process.env.RESERVE_ORDER_WINDOW_HOURS;
    });

    it("activates the group and anchors the root on first payment", async () => {
      const { strapi, orderQuery, groupQuery, raw } = createStrapi();
      orderQuery.findOne.mockResolvedValue({
        id: 11,
        ShippingCost: 45_000,
        reserve_shipment: { id: 5, groupKey: "g-1" },
      });
      groupQuery.findOne.mockResolvedValue({
        id: 5,
        groupKey: "g-1",
        State: RESERVE_GROUP_STATES.pendingActivation,
      });
      raw
        .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // lock
        .mockResolvedValueOnce({ rows: [{ id: 5 }] }); // activation CAS

      const result = await confirmReservePaymentForOrder(strapi, 11);

      expect(result.outcome).toBe("activated");
      expect(groupQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { rootOrder: 11 } }),
      );
    });

    it("only confirms membership for a later attached order", async () => {
      const { strapi, orderQuery, groupQuery, raw } = createStrapi();
      orderQuery.findOne.mockResolvedValue({
        id: 12,
        ShippingCost: 0,
        reserve_shipment: { id: 5, groupKey: "g-1" },
      });
      groupQuery.findOne.mockResolvedValue({
        id: 5,
        groupKey: "g-1",
        State: RESERVE_GROUP_STATES.active,
        expiresAt: "2026-09-11T10:00:00.000Z",
      });
      raw.mockResolvedValue({ rows: [{ id: 5 }] });

      const result = await confirmReservePaymentForOrder(strapi, 12);

      expect(result.outcome).toBe("attached");
      // Crucially the deadline is untouched: attaching never extends the window.
      const updates = groupQuery.update.mock.calls.map((c: any[]) => c[0].data);
      for (const data of updates) expect(data).not.toHaveProperty("expiresAt");
    });

    it("does nothing for an ordinary non-reserve order", async () => {
      const { strapi, orderQuery } = createStrapi();
      orderQuery.findOne.mockResolvedValue({ id: 3, reserve_shipment: null });

      expect(await confirmReservePaymentForOrder(strapi, 3)).toEqual({
        outcome: "not_reserve",
      });
    });
  });

  describe("closing the window", () => {
    it("records automatic expiry distinctly from an early release", async () => {
      const { strapi, raw } = createStrapi();
      raw.mockResolvedValue({ rows: [{ id: 5 }] });
      const now = new Date("2026-09-11T10:00:00.000Z");

      await closeGroup(strapi, {
        groupId: 5,
        reason: RESERVE_CLOSURE_REASONS.expired,
        now,
        requireExpired: true,
      });
      const expiredSql = String(raw.mock.calls[0][0]);
      expect(raw.mock.calls[0][1]).toContain("Expired");
      expect(expiredSql).toMatch(/expires_at <= \?/);

      raw.mockClear();
      await closeGroup(strapi, {
        groupId: 5,
        reason: RESERVE_CLOSURE_REASONS.releasedEarly,
        now,
      });
      expect(raw.mock.calls[0][1]).toContain("ReleasedEarly");
      // An early release must not require the deadline to have passed.
      expect(String(raw.mock.calls[0][0])).not.toMatch(/expires_at <= \?/);
    });

    it("both outcomes land in ReadyToFulfill for normal fulfillment", async () => {
      const { strapi, raw } = createStrapi();
      raw.mockResolvedValue({ rows: [{ id: 5 }] });

      await closeGroup(strapi, { groupId: 5, reason: RESERVE_CLOSURE_REASONS.expired });

      expect(raw.mock.calls[0][1][0]).toBe(RESERVE_GROUP_STATES.readyToFulfill);
    });

    it("cancels a group once nothing paid remains in it", async () => {
      const { strapi, orderQuery, raw } = createStrapi();
      orderQuery.count.mockResolvedValue(0);
      raw.mockResolvedValue({ rows: [{ id: 5 }] });

      expect(await closeGroupIfAbandoned(strapi, 5)).toBe(true);
      expect(raw.mock.calls[0][1]).toContain(RESERVE_CLOSURE_REASONS.rootAbandoned);
    });

    it("keeps a group alive while a paid member remains", async () => {
      const { strapi, orderQuery } = createStrapi();
      orderQuery.count.mockResolvedValue(1);

      expect(await closeGroupIfAbandoned(strapi, 5)).toBe(false);
    });
  });

  describe("fulfillment hold", () => {
    it.each([
      [RESERVE_GROUP_STATES.pendingActivation, true],
      [RESERVE_GROUP_STATES.active, true],
      [RESERVE_GROUP_STATES.readyToFulfill, false],
      [RESERVE_GROUP_STATES.fulfilling, false],
      [RESERVE_GROUP_STATES.completed, false],
    ])("state %s holds the parcel: %s", async (state, held) => {
      const { strapi, orderQuery } = createStrapi();
      orderQuery.findOne.mockResolvedValue({
        id: 1,
        reserve_shipment: { id: 5, groupKey: "g-1", State: state },
      });

      expect((await isOrderHeldByReserve(strapi, 1)).held).toBe(held);
    });

    it("never holds an ordinary order", async () => {
      const { strapi, orderQuery } = createStrapi();
      orderQuery.findOne.mockResolvedValue({ id: 1, reserve_shipment: null });

      expect(await isOrderHeldByReserve(strapi, 1)).toEqual({ held: false, group: null });
    });
  });

  describe("shipping retention on cancellation", () => {
    it("retains shipping while other paid members still ship", async () => {
      const { strapi, orderQuery } = createStrapi();
      orderQuery.count.mockResolvedValue(1);

      const retained = await resolveRetainedReserveShipping(strapi, {
        id: 1,
        ShippingCost: 45_000,
        reserve_shipment: { id: 5 },
      });

      expect(retained).toBe(45_000);
    });

    it("refunds shipping when no paid member is left to ship", async () => {
      const { strapi, orderQuery } = createStrapi();
      orderQuery.count.mockResolvedValue(0);

      const retained = await resolveRetainedReserveShipping(strapi, {
        id: 1,
        ShippingCost: 45_000,
        reserve_shipment: { id: 5 },
      });

      expect(retained).toBe(0);
    });

    it("never retains anything on an ordinary order", async () => {
      const { strapi } = createStrapi();

      expect(
        await resolveRetainedReserveShipping(strapi, {
          id: 1,
          ShippingCost: 45_000,
          reserve_shipment: null,
        }),
      ).toBe(0);
    });
  });

  describe("read-time projection", () => {
    it("reports an expired group as inactive despite stale order columns", () => {
      // The order row still says isReserveOrder=true with its original deadline;
      // only the group knows the window closed.
      const view = projectOrderReserve({
        isReserveOrder: true,
        reserveExpiresAt: "2099-01-01T00:00:00.000Z",
        reserve_shipment: {
          id: 5,
          groupKey: "g-1",
          State: RESERVE_GROUP_STATES.readyToFulfill,
          ClosureReason: RESERVE_CLOSURE_REASONS.expired,
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
      });

      expect(view.reserveIsActive).toBe(false);
      expect(view.reserveIsHeld).toBe(false);
      expect(view.reserveClosureReason).toBe("Expired");
      expect(view.reserveExpiresAt).toBe("2026-09-01T00:00:00.000Z");
    });

    it("keeps early release distinguishable from expiry after the fact", () => {
      const released = projectOrderReserve({
        reserve_shipment: {
          id: 5,
          groupKey: "g-1",
          State: RESERVE_GROUP_STATES.readyToFulfill,
          ClosureReason: RESERVE_CLOSURE_REASONS.releasedEarly,
          expiresAt: "2026-09-11T00:00:00.000Z",
        },
      });

      expect(released.reserveClosureReason).toBe("ReleasedEarly");
    });

    it("reports an active window as active and held", () => {
      const view = projectOrderReserve({
        reserve_shipment: {
          id: 5,
          groupKey: "g-1",
          State: RESERVE_GROUP_STATES.active,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });

      expect(view.reserveIsActive).toBe(true);
      expect(view.reserveIsHeld).toBe(true);
    });

    it("returns a clean non-reserve view for ordinary orders", () => {
      expect(projectOrderReserve({ id: 1 })).toEqual(
        expect.objectContaining({ isReserveOrder: false, reserveGroupId: null }),
      );
    });
  });

  describe("paid membership", () => {
    it.each([
      [0, false],
      [2, true],
    ])("count %s -> hasPaidMember %s", async (count, expected) => {
      const { strapi, orderQuery } = createStrapi();
      orderQuery.count.mockResolvedValue(count);

      expect(await hasPaidMember(strapi, 5)).toBe(expected);
    });
  });

  describe("combined-shipment tracking", () => {
    it("claims one barcode for the group and stamps every member order", async () => {
      const { strapi, raw } = createStrapi();
      // 1) CAS claim on a NULL barcode wins, 2) member orders stamped.
      raw
        .mockResolvedValueOnce({ rows: [{ shipping_barcode: "ANP-1" }] })
        .mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 11 }, { id: 12 }] });

      const result = await claimGroupShippingBarcode(strapi, {
        groupId: 5,
        barcode: "ANP-1",
      });

      expect(result).toEqual({ barcode: "ANP-1", claimed: true, ordersStamped: 3 });

      const [claimSql, claimBindings] = raw.mock.calls[0];
      expect(claimSql).toContain("UPDATE reserve_groups");
      expect(claimSql).toContain("shipping_barcode IS NULL");
      expect(claimBindings).toEqual(["ANP-1", 5]);

      const [stampSql, stampBindings] = raw.mock.calls[1];
      expect(stampSql).toContain("UPDATE orders");
      // Membership lives in the link table. This assertion used to demand
      // `reserve_shipment_id = ?` -- a column Strapi's schema sync drops on every
      // boot -- so the suite stayed green while production threw 42703.
      expect(stampSql).toContain("orders_reserve_shipment_links");
      expect(stampSql).toContain("l.reserve_group_id = ?");
      expect(stampSql).not.toContain("reserve_shipment_id = ?");
      expect(stampBindings).toEqual(["ANP-1", 5]);
    });

    it("never prints a second label: an existing group barcode wins", async () => {
      const { strapi, raw } = createStrapi();
      // The CAS misses because the group already carries a barcode...
      raw
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ shipping_barcode: "ANP-ORIGINAL" }] })
        .mockResolvedValueOnce({ rows: [{ id: 11 }] });

      const result = await claimGroupShippingBarcode(strapi, {
        groupId: 5,
        barcode: "ANP-SECOND",
      });

      // ...so the original is what members are stamped with.
      expect(result).toEqual({
        barcode: "ANP-ORIGINAL",
        claimed: false,
        ordersStamped: 1,
      });
      expect(raw.mock.calls[2][1]).toEqual(["ANP-ORIGINAL", 5]);
    });

    it("only overwrites members that have no barcode of their own", async () => {
      const { strapi, raw } = createStrapi();
      raw
        .mockResolvedValueOnce({ rows: [{ shipping_barcode: "ANP-1" }] })
        .mockResolvedValueOnce({ rows: [] });

      await claimGroupShippingBarcode(strapi, { groupId: 5, barcode: "ANP-1" });

      const [stampSql] = raw.mock.calls[1];
      expect(stampSql).toContain("o.shipping_barcode IS NULL OR o.shipping_barcode = \'\'");
    });

    it("is a no-op for an order that belongs to no group", async () => {
      const { strapi } = createStrapi();
      await expect(findGroupShippingBarcode(strapi, { id: 1 })).resolves.toBeNull();
      await expect(
        findGroupShippingBarcode(strapi, { id: 1, reserve_shipment: null }),
      ).resolves.toBeNull();
    });

    it("reports the group barcode already issued for a member order", async () => {
      const { strapi } = createStrapi();
      await expect(
        findGroupShippingBarcode(strapi, {
          id: 1,
          reserve_shipment: { id: 5, ShippingBarcode: "ANP-1" },
        }),
      ).resolves.toEqual({ groupId: 5, barcode: "ANP-1" });
    });
  });
});