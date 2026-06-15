/**
 * Unit tests for the order-level reservation transitions.
 *
 * These prove the idempotency / safety guarantees that the orchestration tests mock out:
 *  - consume succeeds and consumes each item once,
 *  - consume detects an expired reservation and refuses (success-after-expiry),
 *  - consume is a no-op on an already-processed (duplicate callback) order,
 *  - release frees each item once,
 *  - release is idempotent / paid-order-safe: a non-"Reserved" order is never released.
 *
 * Only the raw-SQL boundary (trx.raw) and the order findOne are mocked; the per-stock
 * atomic helpers are mocked so we can assert exactly when they are (not) invoked.
 */
import {
  consumeOrderReservation,
  releaseOrderReservation,
} from "../stockReservations";
import {
  consumeReservedStockAtomic,
  releaseReservedStockAtomic,
} from "../../api/cart/services/lib/stock";

jest.mock("../../api/cart/services/lib/stock", () => ({
  consumeReservedStockAtomic: jest.fn(),
  releaseReservedStockAtomic: jest.fn(),
}));

const mockedConsume = consumeReservedStockAtomic as jest.MockedFunction<
  typeof consumeReservedStockAtomic
>;
const mockedRelease = releaseReservedStockAtomic as jest.MockedFunction<
  typeof releaseReservedStockAtomic
>;

function createStrapi() {
  const orderFindOne = jest.fn();
  const trx = { raw: jest.fn() };
  const strapi = {
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    db: {
      query: jest.fn((uid: string) => {
        if (uid === "api::order.order") return { findOne: orderFindOne };
        throw new Error(`Unexpected uid: ${uid}`);
      }),
    },
  } as any;
  return { strapi, orderFindOne, trx };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("consumeOrderReservation", () => {
  it("transitions to Consumed and consumes each order item once", async () => {
    const { strapi, orderFindOne, trx } = createStrapi();
    trx.raw.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // transition succeeded
    orderFindOne.mockResolvedValueOnce({
      id: 1,
      order_items: [{ Count: 2, product_variation: { product_stock: { id: 5 } } }],
    });
    mockedConsume.mockResolvedValue({ success: true });

    const res = await consumeOrderReservation(strapi, 1, trx);

    expect(res).toEqual({ success: true });
    expect(mockedConsume).toHaveBeenCalledTimes(1);
    expect(mockedConsume).toHaveBeenCalledWith(strapi, 5, 2, trx);
    // The transition only fires for a still-reserved, not-yet-expired order.
    expect(trx.raw.mock.calls[0][0]).toMatch(/reservation_status = 'Reserved'/);
    expect(trx.raw.mock.calls[0][0]).toMatch(/reserved_until >= NOW\(\)/);
  });

  it("refuses and reports expired when the reservation already lapsed (success after expiry)", async () => {
    const { strapi, orderFindOne, trx } = createStrapi();
    trx.raw.mockResolvedValueOnce({ rows: [] }); // transition matched nothing
    orderFindOne.mockResolvedValueOnce({
      id: 1,
      ReservationStatus: "Reserved",
      ReservedUntil: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await consumeOrderReservation(strapi, 1, trx);

    expect(res).toEqual({ success: true, skipped: true, expired: true });
    expect(mockedConsume).not.toHaveBeenCalled();
  });

  it("is a no-op for a duplicate callback on an already-consumed order", async () => {
    const { strapi, orderFindOne, trx } = createStrapi();
    trx.raw.mockResolvedValueOnce({ rows: [] });
    orderFindOne.mockResolvedValueOnce({
      id: 1,
      ReservationStatus: "Consumed",
      ReservedUntil: null,
    });

    const res = await consumeOrderReservation(strapi, 1, trx);

    expect(res).toEqual({ success: true, skipped: true, expired: false });
    expect(mockedConsume).not.toHaveBeenCalled();
  });
});

describe("releaseOrderReservation", () => {
  it("releases reserved stock for each item once", async () => {
    const { strapi, orderFindOne, trx } = createStrapi();
    trx.raw.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    orderFindOne.mockResolvedValueOnce({
      id: 1,
      order_items: [{ Count: 3, product_variation: { product_stock: { id: 7 } } }],
    });
    mockedRelease.mockResolvedValue({ success: true });

    const res = await releaseOrderReservation(strapi, 1, "Released", trx);

    expect(res).toEqual({ success: true });
    expect(mockedRelease).toHaveBeenCalledTimes(1);
    expect(mockedRelease).toHaveBeenCalledWith(strapi, 7, 3, trx, undefined);
  });

  it("is idempotent and paid-order-safe: never releases when the order is not Reserved", async () => {
    const { strapi, orderFindOne, trx } = createStrapi();
    // A paid (Consumed) order, or a second expiry pass on an already-released order:
    // the guarded transition matches 0 rows, so no stock is added back.
    trx.raw.mockResolvedValueOnce({ rows: [] });

    const res = await releaseOrderReservation(strapi, 1, "Released", trx);

    expect(res).toEqual({ success: true, skipped: true });
    expect(mockedRelease).not.toHaveBeenCalled();
    expect(orderFindOne).not.toHaveBeenCalled();
  });
});
