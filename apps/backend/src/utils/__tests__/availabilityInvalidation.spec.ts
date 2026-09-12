const enqueueEdgeCachePurge = jest.fn().mockResolvedValue(undefined);

jest.mock("../../queue/edge-cache", () => ({
  enqueueEdgeCachePurge: (...args: unknown[]) => enqueueEdgeCachePurge(...args),
}));

import { scheduleAvailabilityTransitionPurge } from "../availabilityInvalidation";

function makeStrapi(product: any) {
  return {
    log: { warn: jest.fn() },
    db: {
      query: () => ({ findOne: jest.fn().mockResolvedValue(product) }),
    },
  };
}

const PRODUCT = {
  product: {
    Slug: "shirt",
    product_main_category: { Slug: "tops" },
    product_other_categories: [{ Slug: "new" }],
  },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("scheduleAvailabilityTransitionPurge", () => {
  beforeEach(() => enqueueEdgeCachePurge.mockClear());

  // The whole point: stock moves constantly, availability rarely.
  it.each([
    ["a sale that empties the last unit", 1, 0],
    ["a restock from zero", 0, 3],
  ])("purges on %s", async (_label, availableBefore, availableAfter) => {
    scheduleAvailabilityTransitionPurge(makeStrapi(PRODUCT) as any, {
      stockId: 7,
      availableBefore,
      availableAfter,
      reason: "test",
    });
    await flush();

    expect(enqueueEdgeCachePurge).toHaveBeenCalledTimes(1);
    const [data] = enqueueEdgeCachePurge.mock.calls[0];
    expect(data.kind).toBe("availability");
    expect(data.paths).toEqual(expect.arrayContaining(["/pdp/shirt", "/plp/category/tops"]));
  });

  it.each([
    ["5 -> 4", 5, 4],
    ["4 -> 5", 4, 5],
    ["0 -> 0", 0, 0],
  ])("does not purge for %s, which changes no rendered state", async (_label, before, after) => {
    scheduleAvailabilityTransitionPurge(makeStrapi(PRODUCT) as any, {
      stockId: 7,
      availableBefore: before,
      availableAfter: after,
      reason: "test",
    });
    await flush();

    expect(enqueueEdgeCachePurge).not.toHaveBeenCalled();
  });

  // Purging inside the transaction would re-render from a snapshot that may roll
  // back, writing the pre-transaction state straight back into the cache.
  it("waits for the transaction to commit", async () => {
    let commit: (value?: unknown) => void = () => undefined;
    const executionPromise = new Promise((resolve) => {
      commit = resolve;
    });

    scheduleAvailabilityTransitionPurge(makeStrapi(PRODUCT) as any, {
      stockId: 7,
      availableBefore: 1,
      availableAfter: 0,
      reason: "test",
      trx: { executionPromise },
    });

    await flush();
    expect(enqueueEdgeCachePurge).not.toHaveBeenCalled();

    commit();
    await flush();
    await flush();
    expect(enqueueEdgeCachePurge).toHaveBeenCalledTimes(1);
  });

  it("does not purge when the transaction rolls back", async () => {
    const executionPromise = Promise.reject(new Error("rolled back"));

    scheduleAvailabilityTransitionPurge(makeStrapi(PRODUCT) as any, {
      stockId: 7,
      availableBefore: 1,
      availableAfter: 0,
      reason: "test",
      trx: { executionPromise },
    });

    await flush();
    await flush();
    expect(enqueueEdgeCachePurge).not.toHaveBeenCalled();
  });

  it("logs rather than throwing when the stock has no product", async () => {
    const strapi = makeStrapi(null);

    scheduleAvailabilityTransitionPurge(strapi as any, {
      stockId: 7,
      availableBefore: 1,
      availableAfter: 0,
      reason: "test",
    });
    await flush();

    expect(enqueueEdgeCachePurge).not.toHaveBeenCalled();
    expect(strapi.log.warn).toHaveBeenCalled();
  });
});
