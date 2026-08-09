import { enqueuePurchaseForOrder, enqueueRefundForReturn } from "../outbox";

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

  it("stores one privacy-safe IRR purchase event keyed by the settlement", async () => {
    const knex = createKnex([{ id: 41 }]);
    const strapi: any = {
      db: { connection: knex.db },
      entityService: {
        findOne: jest.fn().mockResolvedValue({
          id: 7,
          analytics_correlation_id: "guest-abc",
          order_items: [
            {
              ProductSKU: "PRIVATE-SKU",
              ProductTitle: "Shoe",
              PerAmount: 1200,
              Count: 2,
              product_variation: {
                id: 81,
                product: { id: 42, product_main_category: { id: 9 } },
              },
            },
          ],
          contract: {
            contract_transactions: [
              {
                id: 41,
                Type: "Gateway",
                Status: "Success",
                Amount: 24000,
                SettledAt: "2026-08-09T08:30:00.000Z",
              },
            ],
          },
        }),
      },
    };

    await expect(enqueuePurchaseForOrder(strapi, 7)).resolves.toBe(41);
    expect(knex.conflictKeys).toEqual([["website_id", "event_type", "source_type", "source_id"]]);
    const payload: any = knex.insertPayloads[0];
    expect(payload.event_type).toBe("purchase");
    expect(payload.source_type).toBe("settlement_transaction");
    expect(payload.source_id).toBe("41");
    expect(payload.payload.payload.data.revenue).toBe(24000);
    expect(payload.payload.payload.data.revenue_irr).toBe(24000);
    expect(payload.payload.payload.data.value_irr).toBe(24000);
    expect(payload.payload.payload.data.currency).toBe("IRR");
    expect(payload.payload.payload.data.quantity).toBe(2);
    expect(payload.payload.payload.data.product_ids).toBe("42");
    expect(payload.payload.payload.data.variant_ids).toBe("81");
    expect(payload.payload.payload.data.category_ids).toBe("9");
    expect(payload.payload.payload.id).toBe("guest-abc");
    expect(payload.payload.payload.timestamp).toBe(
      Math.floor(new Date("2026-08-09T08:30:00.000Z").getTime() / 1000),
    );
    expect(JSON.stringify(payload.payload)).not.toContain("PRIVATE-SKU");
    expect(payload.payload.payload.data).not.toEqual(
      expect.objectContaining({ order_id: expect.anything(), transaction_id: expect.anything() }),
    );
  });

  it("records a positive refund_irr once per Return transaction", async () => {
    const knex = createKnex([{ id: 99 }]);
    const strapi: any = {
      db: { connection: knex.db },
      entityService: {
        findOne: jest.fn().mockResolvedValue({
          analytics_correlation_id: "guest-abc",
          contract: {
            contract_transactions: [
              { id: 99, Type: "Return", Status: "Success", Date: "2026-08-08T09:00:00.000Z" },
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
        correlationId: "guest-abc",
      }),
    ).resolves.toBe(99);
    const payload: any = knex.insertPayloads[0];
    expect(payload.event_type).toBe("refund");
    expect(payload.source_type).toBe("return_transaction");
    expect(payload.source_id).toBe("99");
    expect(payload.payload.payload.data.refund_irr).toBe(450000);
    expect(payload.payload.payload.data.refund_irr).toBeGreaterThan(0);
    expect(payload.payload.payload.timestamp).toBe(
      Math.floor(new Date("2026-08-08T09:00:00.000Z").getTime() / 1000),
    );
  });
});
