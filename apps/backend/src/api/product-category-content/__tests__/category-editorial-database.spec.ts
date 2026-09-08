import { ensureCategoryEditorialDatabaseInvariant } from "../services/category-editorial-database";

function transactionDouble(duplicates: any[] = []) {
  const query: any = {};
  for (const method of ["select", "count", "whereNotNull", "groupBy", "havingRaw"]) {
    query[method] = jest.fn(() => query);
  }
  query.limit = jest.fn().mockResolvedValue(duplicates);
  const trx: any = jest.fn(() => query);
  trx.raw = jest.fn().mockResolvedValue(undefined);
  return trx;
}

describe("category editorial database invariant", () => {
  it("rechecks links and restores uniqueness after Strapi schema sync", async () => {
    const trx = transactionDouble();
    const connection: any = {
      schema: { hasTable: jest.fn().mockResolvedValue(true) },
      transaction: jest.fn(async (callback: any) => callback(trx)),
    };
    await ensureCategoryEditorialDatabaseInvariant({ db: { connection } } as any);
    expect(trx.raw).toHaveBeenNthCalledWith(1, "SELECT pg_advisory_xact_lock(?, ?)", [17347073, 0]);
    expect(trx.raw).toHaveBeenNthCalledWith(2, expect.stringContaining("ADD CONSTRAINT"));
  });

  it("fails closed on duplicates before changing the constraint", async () => {
    const trx = transactionDouble([{ product_category_id: 9, count: "2" }]);
    const connection: any = {
      schema: { hasTable: jest.fn().mockResolvedValue(true) },
      transaction: jest.fn(async (callback: any) => callback(trx)),
    };
    await expect(
      ensureCategoryEditorialDatabaseInvariant({ db: { connection } } as any),
    ).rejects.toThrow("refused duplicate category links (9)");
    expect(trx.raw).toHaveBeenCalledTimes(1);
  });
});
