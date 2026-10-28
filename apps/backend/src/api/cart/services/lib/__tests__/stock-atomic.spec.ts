/**
 * Unit tests for the atomic stock primitives that back the reservation lifecycle.
 *
 * These mock only the raw-SQL boundary (strapi.db.connection.raw) and the fallback
 * findOne, so they exercise the real guard logic in stock.ts: oversell prevention,
 * insufficient-stock handling, and that the SQL carries the correct WHERE guards.
 * No live DB, no real payment data.
 */
import {
  reserveStockAtomic,
  decrementStockAtomic,
  releaseReservedStockAtomic,
  consumeReservedStockAtomic,
} from "../stock";

// Avoid the fire-and-forget homepage revalidation side effect on success paths.
jest.mock("../../../../../utils/homepageRevalidation", () => ({
  scheduleHomeProductsRevalidation: jest.fn(),
}));

type RawImpl = (sql: string, bindings: any[]) => Promise<{ rows: any[] }>;

function createStrapi(rawImpl: RawImpl, stockOnMiss: any = null) {
  const raw = jest.fn(rawImpl);
  const findOne = jest.fn().mockResolvedValue(stockOnMiss);
  const strapi = {
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    db: {
      connection: { raw },
      query: jest.fn(() => ({ findOne })),
    },
  } as any;
  return { strapi, raw, findOne };
}

describe("atomic stock primitives", () => {
  describe("reserveStockAtomic", () => {
    it("reserves when availability allows and returns the new reserved count", async () => {
      const { strapi, raw } = createStrapi(async () => ({ rows: [{ reserved_count: 3 }] }));

      const res = await reserveStockAtomic(strapi, 10, 2);

      expect(res).toEqual({ success: true, newReservedCount: 3 });
      // The availability guard is what prevents overselling under concurrency.
      expect(raw.mock.calls[0][0]).toMatch(/\(count - COALESCE\(reserved_count, 0\)\) >= \?/);
    });

    it("prevents oversell: fails when the guarded UPDATE affects 0 rows (last-unit loser)", async () => {
      // Two users race for the last unit; the loser's UPDATE matches no row.
      const { strapi } = createStrapi(async () => ({ rows: [] }), {
        Count: 5,
        reservedCount: 5,
      });

      const res = await reserveStockAtomic(strapi, 10, 1);

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Insufficient stock for reservation/);
      expect(res.reason).toBe("insufficient_stock");
    });

    it("distinguishes database failures and missing inventory from shortages", async () => {
      const failed = createStrapi(async () => { throw new Error("connection refused"); });
      expect(await reserveStockAtomic(failed.strapi, 10, 1)).toEqual(expect.objectContaining({ reason: "database_failure" }));
      const missing = createStrapi(async () => ({ rows: [] }));
      expect(await reserveStockAtomic(missing.strapi, 10, 1)).toEqual(expect.objectContaining({ reason: "missing_inventory" }));
    });
    it.each([NaN, Infinity, 0.5])("rejects invalid quantity %s without SQL", async (quantity) => {
      const { strapi, raw } = createStrapi(async () => ({ rows: [] }));
      expect(await reserveStockAtomic(strapi, 10, quantity)).toEqual(expect.objectContaining({ reason: "invalid_quantity" }));
      expect(raw).not.toHaveBeenCalled();
    });

    it("rejects non-positive quantities without touching the DB", async () => {
      const { strapi, raw } = createStrapi(async () => ({ rows: [] }));
      const res = await reserveStockAtomic(strapi, 10, 0);
      expect(res.success).toBe(false);
      expect(raw).not.toHaveBeenCalled();
    });
  });

  describe("decrementStockAtomic", () => {
    it("decrements when stock is sufficient", async () => {
      const { strapi, raw } = createStrapi(async () => ({ rows: [{ count: 8 }] }));

      const res = await decrementStockAtomic(strapi, 10, 2);

      expect(res).toEqual({ success: true, newCount: 8 });
      expect(raw.mock.calls[0][0]).toMatch(/count = count - \?/);
      expect(raw.mock.calls[0][0]).toMatch(/count >= \?/);
    });

    it("fails with an insufficient-stock error on 0 rows", async () => {
      const { strapi } = createStrapi(async () => ({ rows: [] }), {
        Count: 1,
        reservedCount: 0,
      });

      const res = await decrementStockAtomic(strapi, 10, 5);

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Insufficient stock: requested 5, available 1/);
    });
  });

  describe("consumeReservedStockAtomic", () => {
    it("decrements both count and reserved_count atomically", async () => {
      const { strapi, raw } = createStrapi(async () => ({
        rows: [{ count: 8, reserved_count: 1 }],
      }));

      const res = await consumeReservedStockAtomic(strapi, 10, 2);

      expect(res).toEqual({ success: true, newCount: 8, newReservedCount: 1 });
      const sql = raw.mock.calls[0][0];
      expect(sql).toMatch(/count = count - \?/);
      expect(sql).toMatch(/reserved_count = COALESCE\(reserved_count, 0\) - \?/);
      expect(sql).toMatch(/COALESCE\(reserved_count, 0\) >= \?/);
    });

    it("fails when the reservation is missing/insufficient (0 rows)", async () => {
      const { strapi } = createStrapi(async () => ({ rows: [] }), {
        Count: 0,
        reservedCount: 0,
      });

      const res = await consumeReservedStockAtomic(strapi, 10, 2);

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Reservation missing\/insufficient to consume/);
    });
  });

  describe("releaseReservedStockAtomic", () => {
    it("releases reserved_count without touching count", async () => {
      const { strapi, raw } = createStrapi(async () => ({ rows: [{ reserved_count: 0 }] }));

      const res = await releaseReservedStockAtomic(strapi, 10, 2);

      expect(res).toEqual({ success: true, newReservedCount: 0 });
      const sql = raw.mock.calls[0][0];
      expect(sql).toMatch(/reserved_count = COALESCE\(reserved_count, 0\) - \?/);
      expect(sql).toMatch(/COALESCE\(reserved_count, 0\) >= \?/);
      expect(sql).not.toMatch(/count = count -/);
    });

    it("rejects invalid (non-integer / non-positive) quantities without touching the DB", async () => {
      const { strapi, raw } = createStrapi(async () => ({ rows: [] }));

      expect((await releaseReservedStockAtomic(strapi, 10, 0)).success).toBe(false);
      expect((await releaseReservedStockAtomic(strapi, 10, -1)).success).toBe(false);
      expect((await releaseReservedStockAtomic(strapi, 10, 1.5)).success).toBe(false);
      expect(raw).not.toHaveBeenCalled();
    });

    it("fails when there is not enough reserved to release (0 rows)", async () => {
      const { strapi } = createStrapi(async () => ({ rows: [] }), {
        Count: 5,
        reservedCount: 0,
      });

      const res = await releaseReservedStockAtomic(strapi, 10, 2);

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Insufficient reserved stock to release/);
    });
  });
});
