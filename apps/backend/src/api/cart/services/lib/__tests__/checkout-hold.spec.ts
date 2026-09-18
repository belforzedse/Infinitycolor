import { findLiveCheckoutHoldForUser, resolveEligibleCheckoutHold } from "../checkout-hold";
import {
  findOrderPaymentAttempt,
  findPaymentAttempt,
} from "../../../../payment-attempt/services/payment-attempt";
import { runRawSql } from "../../../../../utils/transactionExecutor";

jest.mock("../../../../payment-attempt/services/payment-attempt", () => ({
  findPaymentAttempt: jest.fn(),
  findOrderPaymentAttempt: jest.fn(),
}));

jest.mock("../../../../../utils/transactionExecutor", () => ({
  runRawSql: jest.fn(),
}));

const mockedFindAttempt = findPaymentAttempt as jest.MockedFunction<typeof findPaymentAttempt>;
const mockedFindOrderAttempt = findOrderPaymentAttempt as jest.MockedFunction<
  typeof findOrderPaymentAttempt
>;
const mockedRawSql = runRawSql as jest.MockedFunction<typeof runRawSql>;

const strapi = {
  db: {
    query: jest.fn(),
  },
} as never;

describe("resolveEligibleCheckoutHold", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not credit a hold from another customer's attempt id", async () => {
    mockedFindAttempt.mockResolvedValue(null as never);

    await expect(resolveEligibleCheckoutHold(strapi, 17, "c7d9313b-owner")).resolves.toEqual({
      status: "missing",
    });
    expect(mockedFindAttempt).toHaveBeenCalledWith(strapi, 17, "c7d9313b-owner");
  });

  it("returns expired when the concurrency-safe reservation row is already gone", async () => {
    mockedFindAttempt.mockResolvedValue({
      attemptId: "attempt-1",
      order: { id: 111459 },
    } as never);
    (strapi.db.query as jest.Mock).mockReturnValue({
      findOne: jest.fn().mockResolvedValue({
        id: 111459,
        user: { id: 17 },
        ReservationStatus: "Reserved",
        order_items: [
          {
            Count: 1,
            product_variation: { product_stock: { id: 61157 } },
          },
        ],
      }),
    });
    mockedRawSql.mockResolvedValue({ rows: [] } as never);

    await expect(resolveEligibleCheckoutHold(strapi, 17, "attempt-1")).resolves.toEqual({
      status: "expired",
    });
  });

  it("returns the identified order's stock quantities when the reservation is still held", async () => {
    mockedFindAttempt.mockResolvedValue({
      attemptId: "attempt-1",
      order: { id: 92 },
    } as never);
    (strapi.db.query as jest.Mock).mockReturnValue({
      findOne: jest.fn().mockResolvedValue({
        id: 92,
        user: { id: 17 },
        ReservationStatus: "Reserved",
        order_items: [
          {
            Count: 2,
            product_variation: { product_stock: { id: 800 } },
          },
        ],
      }),
    });
    mockedRawSql.mockResolvedValue({ rows: [{ id: 92 }] } as never);

    const result = await resolveEligibleCheckoutHold(strapi, 17, "attempt-1");
    expect(result.status).toBe("held");
    if (result.status !== "held") return;
    expect(result.hold.orderId).toBe(92);
    expect(result.hold.quantitiesByStockId.get(800)).toBe(2);
  });

  it("returns unavailable when the reservation cannot be read, not missing", async () => {
    mockedFindAttempt.mockRejectedValue(new Error("temporary query failure"));

    await expect(resolveEligibleCheckoutHold(strapi, 17, "c7d9313b-owner")).resolves.toEqual({
      status: "unavailable",
    });
  });
});

describe("findLiveCheckoutHoldForUser", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns none when the customer has no live Paying reservation", async () => {
    (strapi.db.query as jest.Mock).mockReturnValue({
      findMany: jest.fn().mockResolvedValue([]),
    });

    await expect(findLiveCheckoutHoldForUser(strapi, 17)).resolves.toEqual({ status: "none" });
    expect(mockedFindOrderAttempt).not.toHaveBeenCalled();
  });

  it("returns the newest live hold and its payment-attempt identity", async () => {
    (strapi.db.query as jest.Mock).mockReturnValue({
      findMany: jest.fn().mockResolvedValue([
        {
          id: 91,
          user: { id: 17 },
          ReservationStatus: "Reserved",
          ReservedUntil: "2026-09-18T12:00:00.000Z",
          order_items: [
            {
              Count: 1,
              product_variation: { product_stock: { id: 700 } },
            },
          ],
        },
      ]),
    });
    mockedRawSql.mockResolvedValue({ rows: [{ id: 91 }] } as never);
    mockedFindOrderAttempt.mockResolvedValue({
      attemptId: "attempt-live",
      quoteHash: "sha256:original",
      Gateway: "mellat",
    } as never);

    const result = await findLiveCheckoutHoldForUser(strapi, 17);
    expect(result.status).toBe("held");
    if (result.status !== "held") return;
    expect(result.hold.orderId).toBe(91);
    expect(result.hold.attemptId).toBe("attempt-live");
    expect(result.hold.quoteHash).toBe("sha256:original");
    expect(result.hold.gateway).toBe("mellat");
    expect(result.hold.quantitiesByStockId.get(700)).toBe(1);
  });

  it("returns none when the reservation row has already expired", async () => {
    (strapi.db.query as jest.Mock).mockReturnValue({
      findMany: jest.fn().mockResolvedValue([
        {
          id: 91,
          user: { id: 17 },
          ReservationStatus: "Reserved",
          order_items: [
            { Count: 1, product_variation: { product_stock: { id: 700 } } },
          ],
        },
      ]),
    });
    mockedRawSql.mockResolvedValue({ rows: [] } as never);

    await expect(findLiveCheckoutHoldForUser(strapi, 17)).resolves.toEqual({ status: "none" });
  });

  it("returns unavailable when the lookup throws", async () => {
    (strapi.db.query as jest.Mock).mockReturnValue({
      findMany: jest.fn().mockRejectedValue(new Error("connection terminated")),
    });

    await expect(findLiveCheckoutHoldForUser(strapi, 17)).resolves.toEqual({
      status: "unavailable",
    });
  });
});
