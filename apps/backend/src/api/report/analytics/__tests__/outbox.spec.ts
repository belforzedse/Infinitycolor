import {
  __private,
  DELIVERABLE_EVENT_TYPES,
  enqueueOrderPaid,
  enqueueRefundForReturn,
  runAnalyticsOutboxTick,
} from "../outbox";

function createKnex(returning: unknown[]) {
  const insertPayloads: unknown[] = [];
  const conflictKeys: unknown[] = [];
  const db = jest.fn(() => ({
    insert(payload: unknown) {
      insertPayloads.push(payload);
      return {
        onConflict(keys: unknown) {
          conflictKeys.push(keys);
          return {
            ignore() {
              return { returning: async () => returning };
            },
          };
        },
      };
    },
  }));
  return { db, insertPayloads, conflictKeys };
}

describe("analytics outbox commerce events", () => {
  const websiteId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    process.env.UMAMI_BASE_URL = "https://analytics.example.test";
    process.env.UMAMI_WEBSITE_ID = websiteId;
    delete process.env.UMAMI_WEBSITE_ALLOWLIST;
  });

  afterEach(() => {
    delete process.env.UMAMI_BASE_URL;
    delete process.env.UMAMI_WEBSITE_ID;
  });

  it("decodes PostgreSQL JSON values before collector delivery", () => {
    const event = {
      type: "event" as const,
      payload: {
        website: websiteId,
        url: "/commerce/order_paid",
        name: "order_paid",
        data: { value_irr: 120_000, currency: "IRR" },
      },
    };
    expect(__private.parseStoredCollectorEvent(event)).toEqual(event);
    expect(__private.parseStoredCollectorEvent(JSON.stringify(event))).toEqual(event);
    expect(__private.parseStoredCollectorEvent(Buffer.from(JSON.stringify(event)))).toEqual(event);
  });

  it.each([
    "not-json",
    null,
    [],
    { type: "event", payload: { website: websiteId, url: "/commerce/purchase" } },
    {
      type: "event",
      payload: {
        website: websiteId,
        url: "/commerce/purchase",
        name: "purchase",
        data: [],
      },
    },
  ])("rejects an invalid stored collector payload without forwarding it (%p)", (value) => {
    expect(() => __private.parseStoredCollectorEvent(value)).toThrow(
      "ANALYTICS_OUTBOX_PAYLOAD_INVALID",
    );
  });

  const storefrontOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 7,
    createdAt: "2026-09-20T08:00:00.000Z",
    external_source: "SamanKish",
    PaymentGateway: "SamanKish",
    order_items: [{ Count: 2 }, { Count: 1 }],
    contract: {
      contract_transactions: [
        {
          id: 41,
          Type: "Gateway",
          Status: "Success",
          Amount: 20000,
          SettledAt: "2026-09-20T08:30:00.000Z",
        },
        {
          id: 42,
          Type: "Gateway",
          Status: "Success",
          Amount: 4000,
          SettledAt: "2026-09-20T08:29:00.000Z",
        },
        { id: 43, Type: "Gateway", Status: "Failed", Amount: 20000 },
      ],
    },
    ...overrides,
  });

  it("stores one non-revenue order_paid per storefront order, summing split legs", async () => {
    const knex = createKnex([{ id: 51 }]);
    const strapi: any = {
      db: { connection: knex.db },
      entityService: { findOne: jest.fn().mockResolvedValue(storefrontOrder()) },
    };

    await expect(enqueueOrderPaid(strapi, 7)).resolves.toBe(51);
    expect(knex.insertPayloads).toHaveLength(1);
    const payload: any = knex.insertPayloads[0];
    expect(payload.event_type).toBe("order_paid");
    expect(payload.source_type).toBe("order");
    expect(payload.source_id).toBe("7");
    expect(payload.payload.payload.name).toBe("order_paid");
    expect(payload.payload.payload.url).toBe("/commerce/order_paid");
    expect(payload.payload.payload.data).toEqual({
      value_irr: 24000,
      item_count: 3,
      gateway: "samankish",
      currency: "IRR",
    });
    // Never Umami's special revenue key, and never a distinct id: a server event
    // cannot join a shopper's session, so it must not claim the purchase.
    expect(payload.payload.payload.data).not.toHaveProperty("revenue");
    expect(payload.payload.payload).not.toHaveProperty("id");
    expect(payload.payload.payload.timestamp).toBe(
      Math.floor(new Date("2026-09-20T08:30:00.000Z").getTime() / 1000),
    );
  });

  it("never turns a WooCommerce-imported order into a storefront event", async () => {
    const knex = createKnex([{ id: 51 }]);
    const strapi: any = {
      db: { connection: knex.db },
      entityService: {
        findOne: jest
          .fn()
          .mockResolvedValue(storefrontOrder({ external_source: "woocommerce" })),
      },
    };
    await expect(enqueueOrderPaid(strapi, 7)).resolves.toBeNull();
    expect(knex.insertPayloads).toHaveLength(0);
  });

  it("ignores orders created before the storefront cutover", async () => {
    const knex = createKnex([{ id: 51 }]);
    const strapi: any = {
      db: { connection: knex.db },
      entityService: {
        findOne: jest
          .fn()
          .mockResolvedValue(storefrontOrder({ createdAt: "2026-09-10T08:00:00.000Z" })),
      },
    };
    await expect(enqueueOrderPaid(strapi, 7)).resolves.toBeNull();
    expect(knex.insertPayloads).toHaveLength(0);
  });

  it("keeps a Mellat order whose external_source is still NULL", async () => {
    const knex = createKnex([{ id: 52 }]);
    const strapi: any = {
      db: { connection: knex.db },
      entityService: {
        findOne: jest
          .fn()
          .mockResolvedValue(
            storefrontOrder({ external_source: null, PaymentGateway: "Mellat" }),
          ),
      },
    };
    await expect(enqueueOrderPaid(strapi, 7)).resolves.toBe(52);
    expect((knex.insertPayloads[0] as any).payload.payload.data.gateway).toBe("mellat");
  });

  it("does not queue an order with no settled charge", async () => {
    const knex = createKnex([{ id: 51 }]);
    const strapi: any = {
      db: { connection: knex.db },
      entityService: {
        findOne: jest.fn().mockResolvedValue(
          storefrontOrder({
            contract: { contract_transactions: [{ id: 1, Status: "Pending", Amount: 10 }] },
          }),
        ),
      },
    };
    await expect(enqueueOrderPaid(strapi, 7)).resolves.toBeNull();
    expect(knex.insertPayloads).toHaveLength(0);
  });

  it("repairs only storefront orders after the cutover and claims only deliverable types", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [] });
    const whereInCalls: Array<[string, unknown]> = [];
    const chain: any = {
      where: () => chain,
      whereIn: (column: string, values: unknown) => {
        whereInCalls.push([column, values]);
        return chain;
      },
      orderBy: () => chain,
      forUpdate: () => chain,
      skipLocked: () => chain,
      limit: async () => [],
      update: async () => 0,
    };
    const trx: any = jest.fn(() => chain);
    const db: any = jest.fn(() => chain);
    db.raw = raw;
    db.transaction = async (callback: (trx: unknown) => unknown) => callback(trx);
    const strapi: any = { db: { connection: db }, log: { warn: jest.fn() } };

    await runAnalyticsOutboxTick(strapi, { limit: 5 });

    const [orderScan, refundScan] = raw.mock.calls;
    for (const [sql, bindings] of [orderScan, refundScan]) {
      expect(sql).toContain("o.external_source IS DISTINCT FROM 'woocommerce'");
      expect(sql).toContain("o.created_at >= ?");
      expect(bindings).toContain(__private.STOREFRONT_ANALYTICS_FLOOR);
    }
    expect(orderScan[0]).toContain("ao.event_type = 'order_paid'");
    expect(whereInCalls).toContainEqual(["event_type", [...DELIVERABLE_EVENT_TYPES]]);
    expect(DELIVERABLE_EVENT_TYPES).not.toContain("purchase");
  });

  it("rejects collector timestamps from before the storefront cutover", () => {
    expect(__private.toCollectorTimestamp("2026-04-09T08:00:00.000Z")).toBeUndefined();
    expect(__private.toCollectorTimestamp("2026-09-20T08:00:00.000Z")).toBe(
      Math.floor(new Date("2026-09-20T08:00:00.000Z").getTime() / 1000),
    );
  });

  it("records a positive refund_irr once per Return transaction", async () => {
    const knex = createKnex([{ id: 99 }]);
    const strapi: any = {
      db: { connection: knex.db },
      entityService: {
        findOne: jest.fn().mockResolvedValue({
          id: 7,
          createdAt: "2026-09-20T08:00:00.000Z",
          external_source: "SnappPay",
          contract: {
            contract_transactions: [
              { id: 99, Type: "Return", Status: "Success", Date: "2026-09-21T09:00:00.000Z" },
            ],
          },
        }),
      },
    };
    await expect(
      enqueueRefundForReturn(strapi, {
        orderId: 7,
        contractTransactionId: 99,
        amountToman: 45000,
      }),
    ).resolves.toBe(99);
    const payload: any = knex.insertPayloads[0];
    expect(payload.event_type).toBe("refund");
    expect(payload.source_type).toBe("return_transaction");
    expect(payload.source_id).toBe("99");
    expect(payload.payload.payload.data.refund_irr).toBe(450000);
    expect(payload.payload.payload.data.refund_irr).toBeGreaterThan(0);
    expect(payload.payload.payload.timestamp).toBe(
      Math.floor(new Date("2026-09-21T09:00:00.000Z").getTime() / 1000),
    );
    expect(payload.payload.payload).not.toHaveProperty("id");
  });

  it("does not record refunds of WooCommerce-imported orders", async () => {
    const knex = createKnex([{ id: 99 }]);
    const strapi: any = {
      db: { connection: knex.db },
      entityService: {
        findOne: jest.fn().mockResolvedValue({
          id: 8,
          createdAt: "2026-09-20T08:00:00.000Z",
          external_source: "woocommerce",
          contract: { contract_transactions: [] },
        }),
      },
    };
    await expect(
      enqueueRefundForReturn(strapi, { orderId: 8, contractTransactionId: 100, amountIrr: 5000 }),
    ).resolves.toBeNull();
    expect(knex.insertPayloads).toHaveLength(0);
  });
});
