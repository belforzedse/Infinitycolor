/**
 * Control-flow tests for the limited-coupon claim.
 *
 * The SQL itself (guarded UPDATE semantics under real concurrency) is proven against a
 * real Postgres in src/__tests__/integration/tier1/coupon-claim.int.spec.ts. What is
 * asserted here is the surrounding contract: which statements run at all, in which
 * order, and what the helpers refuse to do.
 */
import {
  DISCOUNT_USAGE_EXHAUSTED,
  claimLimitedDiscountUsage,
  orderHoldsDiscountClaim,
  releaseOrderDiscountClaim,
} from "../discount-claim";

type Statement = { sql: string; bindings: any[] };

function createHarness(options: {
  discount?: any;
  /** Rows the guarded discounts UPDATE returns; [] means the cap is already reached. */
  discountUpdateRows?: any[];
  /** Rows the guarded orders claim-release UPDATE returns; [] means nothing to release. */
  claimReleaseRows?: any[];
  order?: any;
}) {
  const statements: Statement[] = [];

  const raw = jest.fn(async (sql: string, bindings: any[]) => {
    statements.push({ sql, bindings });
    if (/UPDATE discounts/.test(sql) && /\+ 1/.test(sql)) {
      return { rows: options.discountUpdateRows ?? [{ used_times: 1 }] };
    }
    if (/SELECT discount_usage_claimed_discount_id/.test(sql) && /FOR UPDATE/.test(sql)) {
      return { rows: options.claimReleaseRows ?? [] };
    }
    return { rows: [] };
  });

  const trx = { raw };

  const strapi: any = {
    log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    db: {
      query: jest.fn((uid: string) => {
        if (uid === "api::discount.discount") {
          return { findOne: jest.fn(async () => options.discount ?? null) };
        }
        if (uid === "api::order.order") {
          return { findOne: jest.fn(async () => options.order ?? null) };
        }
        throw new Error(`unexpected uid ${uid}`);
      }),
      // No ambient transaction in these tests; runRawSql must use the trx it is handed.
      inTransaction: () => false,
      connection: { raw: jest.fn(async () => ({ rows: [] })) },
    },
  };

  const sqlMatching = (pattern: RegExp) =>
    statements.filter((statement) => pattern.test(statement.sql));

  return { strapi, trx, statements, sqlMatching };
}

describe("claimLimitedDiscountUsage", () => {
  it("does nothing when the order carries no coupon", async () => {
    const { strapi, trx, statements } = createHarness({});

    await expect(
      claimLimitedDiscountUsage(strapi, { orderId: 1, code: "", trx }),
    ).resolves.toEqual({ claimed: false });
    expect(statements).toEqual([]);
  });

  it("does nothing for an unlimited coupon, leaving settlement to count it", async () => {
    const { strapi, trx, statements } = createHarness({
      discount: { id: 7, Code: "FREESHIP", LimitUsage: 0, UsedTimes: 12 },
    });

    await expect(
      claimLimitedDiscountUsage(strapi, { orderId: 1, code: "FREESHIP", trx }),
    ).resolves.toEqual({ claimed: false });
    expect(statements).toEqual([]);
  });

  it("claims one usage and records it on the order", async () => {
    const { strapi, trx, sqlMatching } = createHarness({
      discount: { id: 7, Code: "LAST1", LimitUsage: 1, UsedTimes: 0 },
      discountUpdateRows: [{ used_times: 1 }],
    });

    await expect(
      claimLimitedDiscountUsage(strapi, { orderId: 42, code: "LAST1", trx }),
    ).resolves.toEqual({ claimed: true, discountId: 7, usedTimes: 1 });

    const increment = sqlMatching(/UPDATE discounts/)[0];
    expect(increment.sql).toMatch(/COALESCE\(used_times, 0\) < \?/);
    expect(increment.bindings).toEqual([7, 1]);

    const stamp = sqlMatching(/discount_usage_claimed_discount_id = \?/)[0];
    expect(stamp.bindings).toEqual([7, 42]);
  });

  it("throws when the cap is already reached and never stamps the order", async () => {
    const { strapi, trx, sqlMatching } = createHarness({
      discount: { id: 7, Code: "LAST1", LimitUsage: 1, UsedTimes: 1 },
      discountUpdateRows: [],
    });

    await expect(
      claimLimitedDiscountUsage(strapi, { orderId: 42, code: "LAST1", trx }),
    ).rejects.toThrow(DISCOUNT_USAGE_EXHAUSTED);

    expect(sqlMatching(/discount_usage_claimed_discount_id = \?/)).toHaveLength(0);
  });

  it("refuses to claim outside a transaction", async () => {
    const { strapi } = createHarness({
      discount: { id: 7, Code: "LAST1", LimitUsage: 1, UsedTimes: 0 },
    });

    await expect(
      claimLimitedDiscountUsage(strapi, { orderId: 42, code: "LAST1", trx: undefined }),
    ).rejects.toThrow("DISCOUNT_CLAIM_REQUIRES_TRANSACTION");
  });
});

describe("releaseOrderDiscountClaim", () => {
  it("decrements exactly once when the CAS matches", async () => {
    const { strapi, trx, sqlMatching } = createHarness({
      claimReleaseRows: [{ released_discount_id: 7 }],
    });

    await expect(releaseOrderDiscountClaim(strapi, 42, trx)).resolves.toEqual({
      released: true,
      discountId: 7,
    });

    const decrements = sqlMatching(/GREATEST\(0, COALESCE\(used_times, 0\) - 1\)/);
    expect(decrements).toHaveLength(1);
    expect(decrements[0].bindings).toEqual([7]);
  });

  it("is a no-op when the claim was already released", async () => {
    const { strapi, trx, sqlMatching } = createHarness({ claimReleaseRows: [] });

    await expect(releaseOrderDiscountClaim(strapi, 42, trx)).resolves.toEqual({
      released: false,
    });
    expect(sqlMatching(/GREATEST\(0, COALESCE\(used_times, 0\) - 1\)/)).toHaveLength(0);
  });

  it("guards the release against orders that already settled", async () => {
    const { strapi, trx, sqlMatching } = createHarness({ claimReleaseRows: [] });

    await releaseOrderDiscountClaim(strapi, 42, trx);

    const claimLookup = sqlMatching(/FOR UPDATE/)[0];
    expect(claimLookup.sql).toMatch(/status NOT IN \(\?, \?, \?, \?\)/);
    expect(claimLookup.bindings).toEqual([42, "Started", "Shipment", "Done", "Returned"]);
    // Nothing matched, so the claim column is never cleared.
    expect(sqlMatching(/discount_usage_claimed_discount_id = NULL/)).toHaveLength(0);
  });

  it("reads the claim under a row lock rather than trusting UPDATE ... RETURNING", async () => {
    // Postgres RETURNING yields post-update values, so an UPDATE that nulls the column
    // could never report which discount it just freed.
    const { strapi, trx, sqlMatching } = createHarness({
      claimReleaseRows: [{ released_discount_id: 7 }],
    });

    await releaseOrderDiscountClaim(strapi, 42, trx);

    expect(sqlMatching(/FOR UPDATE/)).toHaveLength(1);
    expect(sqlMatching(/discount_usage_claimed_discount_id = NULL/)).toHaveLength(1);
  });

  it("never throws out of a cancellation path", async () => {
    const { strapi, trx } = createHarness({});
    trx.raw.mockRejectedValueOnce(new Error("connection reset"));

    await expect(releaseOrderDiscountClaim(strapi, 42, trx)).resolves.toEqual({
      released: false,
    });
    expect(strapi.log.error).toHaveBeenCalled();
  });
});

describe("orderHoldsDiscountClaim", () => {
  it("is true only while the order holds a claim", async () => {
    const held = createHarness({ order: { id: 1, DiscountUsageClaimedDiscountId: 7 } });
    await expect(orderHoldsDiscountClaim(held.strapi, 1)).resolves.toBe(true);

    const released = createHarness({ order: { id: 1, DiscountUsageClaimedDiscountId: null } });
    await expect(orderHoldsDiscountClaim(released.strapi, 1)).resolves.toBe(false);

    const missing = createHarness({ order: null });
    await expect(orderHoldsDiscountClaim(missing.strapi, 1)).resolves.toBe(false);
  });
});
