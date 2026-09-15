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

  // Crossing zero changes the product *cards* too, so listings go with the PDP.
  it.each([
    ["a sale that empties the last unit", 1, 0],
    ["a restock from zero", 0, 3],
  ])("purges listings on %s", async (_label, availableBefore, availableAfter) => {
    scheduleAvailabilityTransitionPurge(makeStrapi(PRODUCT) as any, {
      stockId: 7,
      availableBefore,
      availableAfter,
      reason: "test",
    });
    await flush();

    expect(enqueueEdgeCachePurge).toHaveBeenCalledTimes(1);
    const [data, options] = enqueueEdgeCachePurge.mock.calls[0];
    expect(data.kind).toBe("availability");
    expect(data.paths).toEqual(expect.arrayContaining(["/pdp/shirt", "/plp/category/tops"]));
    expect(data.origin).toEqual({ productSlug: "shirt", availabilityCrossed: true });
    expect(options.dedupeKey).toBe("availability:shirt:crossing");
  });

  // At or below the threshold the PDP prints the number and caps the quantity
  // selector at it, so the displayed value moved even though nothing sold out.
  it.each([
    ["5 -> 4", 5, 4],
    ["4 -> 5", 4, 5],
    ["6 -> 5, the first move that renders a number", 6, 5],
  ])("purges the PDP alone for %s", async (_label, before, after) => {
    scheduleAvailabilityTransitionPurge(makeStrapi(PRODUCT) as any, {
      stockId: 7,
      availableBefore: before,
      availableAfter: after,
      reason: "test",
    });
    await flush();

    expect(enqueueEdgeCachePurge).toHaveBeenCalledTimes(1);
    const [data, options] = enqueueEdgeCachePurge.mock.calls[0];
    expect(data.paths).toEqual(["/pdp/shirt"]);
    expect(data.paths).not.toEqual(expect.arrayContaining(["/plp/category/tops"]));
    expect(data.origin).toEqual({ productSlug: "shirt", availabilityCrossed: false });
    // A distinct key from the crossing scope, so the two cannot collide inside
    // one dedupe bucket and silently drop the wider purge.
    expect(options.dedupeKey).toBe("availability:shirt:count");
  });

  it.each([
    ["40 -> 39, both far above the threshold", 40, 39],
    ["7 -> 6, still one short of being rendered", 7, 6],
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
