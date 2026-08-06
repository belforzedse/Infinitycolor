import {
  buildEcommerceTrackingUrl,
  buildRefundTrackingUrl,
  isServerEcommerceTrackingEnabled,
  trackOrderToMatomo,
  trackRefundToMatomo,
} from "../matomo-tracker";
import { RedisClient } from "../../../../index";

function installEnv() {
  process.env.MATOMO_BASE_URL = "https://matomo.example.com";
  process.env.MATOMO_SITE_ID = "1";
  process.env.MATOMO_API_TOKEN = "test-token";
  delete process.env.MATOMO_SERVER_TRACKING_ENABLED;
}

function makeStrapi(order: any) {
  return {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    entityService: { findOne: jest.fn(async () => order) },
  };
}

describe("matomo-tracker — server-side ecommerce", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    installEnv();
  });

  it("is enabled when configured and not explicitly disabled", () => {
    expect(isServerEcommerceTrackingEnabled()).toBe(true);
    process.env.MATOMO_SERVER_TRACKING_ENABLED = "false";
    expect(isServerEcommerceTrackingEnabled()).toBe(false);
    process.env.MATOMO_SERVER_TRACKING_ENABLED = "true";
    expect(isServerEcommerceTrackingEnabled()).toBe(true);
    delete process.env.MATOMO_API_TOKEN;
    expect(isServerEcommerceTrackingEnabled()).toBe(false);
  });

  it("builds a valid ecommerce order tracking URL", () => {
    const url = buildEcommerceTrackingUrl({
      orderId: 555,
      userId: 42,
      subtotalToman: 100000,
      discountToman: 10000,
      shippingToman: 5000,
      taxToman: 0,
      items: [{ sku: "SKU-1", name: "Shoe", priceToman: 50000, quantity: 2 }],
    });
    const u = new URL(url);
    expect(u.pathname.endsWith("/matomo.php")).toBe(true);
    expect(u.searchParams.get("idgoal")).toBe("0");
    expect(u.searchParams.get("ec_id")).toBe("555");
    // 100000 - 10000 + 5000 + 0
    expect(u.searchParams.get("revenue")).toBe("95000");
    expect(u.searchParams.get("ec_st")).toBe("100000");
    expect(u.searchParams.get("ec_dt")).toBe("10000");
    expect(u.searchParams.get("uid")).toBe("42");
    expect(JSON.parse(u.searchParams.get("ec_items") || "[]")).toEqual([
      ["SKU-1", "Shoe", "", 50000, 2],
    ]);
    // Token is sent server-side only (never to a browser).
    expect(u.searchParams.get("token_auth")).toBe("test-token");
  });

  it("tracks a confirmed order exactly once (idempotent)", async () => {
    const redis: any = await (RedisClient as unknown as Promise<any>);
    redis.set.mockReset();
    redis.del.mockReset();
    // First claim succeeds, second is already taken.
    redis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true, status: 204, json: async () => ({}) } as any);

    const order = {
      id: 555,
      user: { id: 42 },
      AppliedDiscountAmount: 0,
      ShippingCost: 0,
      ShippingTax: 0,
      order_items: [{ ProductSKU: "SKU-1", ProductTitle: "Shoe", PerAmount: "50000", Count: 2 }],
    };
    const strapi = makeStrapi(order);

    const first = await trackOrderToMatomo(strapi as any, 555);
    const second = await trackOrderToMatomo(strapi as any, 555);

    expect(first).toBe(true);
    expect(second).toBe(false); // idempotency guard blocked the duplicate
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("populates ec_items category from the order item's product main category", async () => {
    const redis: any = await (RedisClient as unknown as Promise<any>);
    redis.set.mockReset();
    redis.del.mockReset();
    redis.set.mockResolvedValueOnce("OK");

    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true, status: 204, json: async () => ({}) } as any);

    const order = {
      id: 777,
      user: { id: 42 },
      AppliedDiscountAmount: 0,
      ShippingCost: 0,
      ShippingTax: 0,
      order_items: [
        {
          ProductSKU: "SKU-1",
          ProductTitle: "Shoe",
          PerAmount: "50000",
          Count: 1,
          product_variation: {
            product: { product_main_category: { Title: "Footwear" } },
          },
        },
      ],
    };
    const strapi = makeStrapi(order);

    await trackOrderToMatomo(strapi as any, 777);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(JSON.parse(calledUrl.searchParams.get("ec_items") || "[]")).toEqual([
      ["SKU-1", "Shoe", "Footwear", 50000, 1],
    ]);
  });

  it("builds a valid refund tracking URL as a custom event, not a second ecommerce order", () => {
    const url = buildRefundTrackingUrl({
      orderId: 555,
      contractTransactionId: 999,
      amountToman: 45_000,
      userId: 42,
    });
    const u = new URL(url);
    expect(u.pathname.endsWith("/matomo.php")).toBe(true);
    expect(u.searchParams.get("e_c")).toBe("ecommerce");
    expect(u.searchParams.get("e_a")).toBe("refund");
    expect(u.searchParams.get("e_n")).toBe("555");
    expect(u.searchParams.get("e_v")).toBe("45000");
    expect(u.searchParams.get("uid")).toBe("42");
    // Never a second ecommerce order for the same ec_id — Matomo rejects that.
    expect(u.searchParams.get("idgoal")).toBeNull();
    expect(u.searchParams.get("ec_id")).toBeNull();
  });

  it("tracks a refund exactly once per contract-transaction row (idempotent)", async () => {
    const redis: any = await (RedisClient as unknown as Promise<any>);
    redis.set.mockReset();
    redis.del.mockReset();
    redis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true, status: 204, json: async () => ({}) } as any);

    const first = await trackRefundToMatomo(makeStrapi({}) as any, {
      orderId: 555,
      contractTransactionId: 999,
      amountToman: 45_000,
      userId: 42,
    });
    const second = await trackRefundToMatomo(makeStrapi({}) as any, {
      orderId: 555,
      contractTransactionId: 999,
      amountToman: 45_000,
      userId: 42,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not track a refund of zero (or negative) amount", async () => {
    const fetchMock = jest.spyOn(global, "fetch" as any);
    const result = await trackRefundToMatomo(makeStrapi({}) as any, {
      orderId: 555,
      contractTransactionId: 1000,
      amountToman: 0,
    });
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases the refund idempotency marker if sending fails so a retry can re-claim", async () => {
    const redis: any = await (RedisClient as unknown as Promise<any>);
    redis.set.mockReset();
    redis.del.mockReset();
    redis.set.mockResolvedValue("OK");
    jest.spyOn(global, "fetch" as any).mockRejectedValue(new Error("network down"));

    const result = await trackRefundToMatomo(makeStrapi({}) as any, {
      orderId: 555,
      contractTransactionId: 1001,
      amountToman: 45_000,
    });
    expect(result).toBe(false);
    expect(redis.del).toHaveBeenCalledWith("matomo:refund-tracked:1001");
  });

  it("skips when disabled and never calls fetch", async () => {
    process.env.MATOMO_SERVER_TRACKING_ENABLED = "false";
    const fetchMock = jest.spyOn(global, "fetch" as any);
    const result = await trackOrderToMatomo(makeStrapi({ id: 1 }) as any, 1);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases the idempotency marker if sending fails so a retry can re-claim", async () => {
    const redis: any = await (RedisClient as unknown as Promise<any>);
    redis.set.mockReset();
    redis.del.mockReset();
    redis.set.mockResolvedValue("OK");
    jest.spyOn(global, "fetch" as any).mockRejectedValue(new Error("network down"));

    const strapi = makeStrapi({
      id: 9,
      user: { id: 1 },
      order_items: [{ ProductSKU: "S", ProductTitle: "T", PerAmount: "100", Count: 1 }],
    });
    const result = await trackOrderToMatomo(strapi as any, 9);
    expect(result).toBe(false);
    expect(redis.del).toHaveBeenCalledWith("matomo:order-tracked:9");
  });
});
