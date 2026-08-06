import {
  reconcileCommerceWindow,
  upsertReconciliationRow,
} from "../commerceReconciliation";
import { getDailySalesRollupRows } from "../../sources/commerce";
import { getMatomoEcommerceSummary } from "../../../services/matomo";

jest.mock("../../sources/commerce", () => ({
  getDailySalesRollupRows: jest.fn(),
}));
jest.mock("../../../services/matomo", () => ({
  getMatomoEcommerceSummary: jest.fn(),
}));

const mockedGetDailySalesRollupRows = getDailySalesRollupRows as jest.MockedFunction<
  typeof getDailySalesRollupRows
>;
const mockedGetMatomoEcommerceSummary = getMatomoEcommerceSummary as jest.MockedFunction<
  typeof getMatomoEcommerceSummary
>;

const JOINS = {} as any;
const START = new Date("2026-05-05T00:00:00Z");
const END = new Date("2026-05-05T23:59:59Z");

function salesRow(overrides: Partial<Awaited<ReturnType<typeof getDailySalesRollupRows>>[number]> = {}) {
  return {
    bucketDate: "2026-05-05",
    grossToman: 1_000_000,
    discountsToman: 0,
    refundsToman: 0,
    netToman: 1_000_000,
    units: 5,
    eligibleOrders: 10,
    totalOrders: 10,
    ...overrides,
  };
}

describe("reconcileCommerceWindow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("sums Strapi rows across the window and returns matomo_unavailable when Matomo can't be reached", async () => {
    mockedGetDailySalesRollupRows.mockResolvedValue([salesRow()]);
    mockedGetMatomoEcommerceSummary.mockResolvedValue(null);

    const result = await reconcileCommerceWindow({} as any, JOINS, START, END);

    expect(result.strapi).toEqual({ orders: 10, grossToman: 1_000_000, netToman: 1_000_000 });
    expect(result.matomo).toBeNull();
    expect(result.ordersDelta).toBeNull();
    expect(result.revenueRatio).toBeNull();
    expect(result.possibleCurrencyMismatch).toBe(false);
    expect(result.status).toBe("matomo_unavailable");
  });

  it("marks status matched when the revenue ratio is close to 1", async () => {
    mockedGetDailySalesRollupRows.mockResolvedValue([salesRow({ grossToman: 1_000_000, eligibleOrders: 10 })]);
    mockedGetMatomoEcommerceSummary.mockResolvedValue({ orders: 8, revenue: 900_000 });

    const result = await reconcileCommerceWindow({} as any, JOINS, START, END);

    expect(result.revenueRatio).toBeCloseTo(0.9);
    expect(result.ordersDelta).toBe(-2);
    expect(result.possibleCurrencyMismatch).toBe(false);
    expect(result.status).toBe("matched");
  });

  it("flags possibleCurrencyMismatch when the ratio is ~10x (Matomo revenue much larger)", async () => {
    mockedGetDailySalesRollupRows.mockResolvedValue([salesRow({ grossToman: 1_000_000 })]);
    mockedGetMatomoEcommerceSummary.mockResolvedValue({ orders: 10, revenue: 10_000_000 });

    const result = await reconcileCommerceWindow({} as any, JOINS, START, END);

    expect(result.revenueRatio).toBe(10);
    expect(result.possibleCurrencyMismatch).toBe(true);
    expect(result.status).toBe("diverged");
  });

  it("flags possibleCurrencyMismatch when the ratio is ~0.1x (Matomo revenue much smaller)", async () => {
    mockedGetDailySalesRollupRows.mockResolvedValue([salesRow({ grossToman: 10_000_000 })]);
    mockedGetMatomoEcommerceSummary.mockResolvedValue({ orders: 10, revenue: 1_000_000 });

    const result = await reconcileCommerceWindow({} as any, JOINS, START, END);

    expect(result.revenueRatio).toBe(0.1);
    expect(result.possibleCurrencyMismatch).toBe(true);
    expect(result.status).toBe("diverged");
  });

  it("marks status diverged (not currency mismatch) for a large but non-10x gap", async () => {
    mockedGetDailySalesRollupRows.mockResolvedValue([salesRow({ grossToman: 1_000_000 })]);
    mockedGetMatomoEcommerceSummary.mockResolvedValue({ orders: 10, revenue: 50_000 });

    const result = await reconcileCommerceWindow({} as any, JOINS, START, END);

    expect(result.revenueRatio).toBe(0.05);
    expect(result.possibleCurrencyMismatch).toBe(false);
    expect(result.status).toBe("diverged");
  });

  it("treats a zero-revenue Strapi window with zero Matomo revenue as unratioed, not a false match", async () => {
    mockedGetDailySalesRollupRows.mockResolvedValue([]);
    mockedGetMatomoEcommerceSummary.mockResolvedValue({ orders: 0, revenue: 0 });

    const result = await reconcileCommerceWindow({} as any, JOINS, START, END);

    expect(result.strapi).toEqual({ orders: 0, grossToman: 0, netToman: 0 });
    expect(result.revenueRatio).toBeNull();
    expect(result.status).toBe("diverged");
  });
});

describe("upsertReconciliationRow", () => {
  it("upserts with matomo fields as null when Matomo was unavailable", async () => {
    const raw = jest.fn().mockResolvedValue({});
    const knex = { raw };

    await upsertReconciliationRow(knex as any, "2026-05-05", {
      window: { start: "2026-05-05", end: "2026-05-05" },
      strapi: { orders: 3, grossToman: 300_000, netToman: 300_000 },
      matomo: null,
      ordersDelta: null,
      revenueRatio: null,
      possibleCurrencyMismatch: false,
      status: "matomo_unavailable",
    });

    expect(raw).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO analytics_reconciliation_daily"),
      ["2026-05-05", 3, 300_000, 300_000, null, null, null, null, false, "matomo_unavailable"],
    );
  });
});
