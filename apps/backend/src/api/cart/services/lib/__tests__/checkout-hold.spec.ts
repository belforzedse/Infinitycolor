import { resolveEligibleCheckoutHold } from "../checkout-hold";
import { findPaymentAttempt } from "../../../../payment-attempt/services/payment-attempt";
import { runRawSql } from "../../../../../utils/transactionExecutor";

jest.mock("../../../../payment-attempt/services/payment-attempt", () => ({
  findPaymentAttempt: jest.fn(),
}));

jest.mock("../../../../../utils/transactionExecutor", () => ({
  runRawSql: jest.fn(),
}));

const mockedFindAttempt = findPaymentAttempt as jest.MockedFunction<typeof findPaymentAttempt>;
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
