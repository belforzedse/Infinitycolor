import { enqueueSnappayOperation } from "../../../queue/snappay";
import { createSnappayAdapter } from "../services/snappay";
import {
  extractSnappayPaymentTokenFromRedirectUrl,
  processSnappayOperation,
} from "../services/snappay-orchestrator";
import {
  displaySnappayFingerprint,
  snappayTokenFingerprint,
} from "../services/snappay-security";
import { SNAPPAY_RECONCILIATION_DELAYS_MS } from "../services/snappay-state-machine";

jest.mock("../../../queue/snappay", () => ({
  enqueueSnappayOperation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/snappay", () => ({
  createSnappayAdapter: jest.fn(),
}));
jest.mock("../services/snappay-category-mapper", () => ({
  mapToSnappayCategory: jest.fn().mockResolvedValue("OTHER"),
}));

const mockedAdapter = createSnappayAdapter as jest.MockedFunction<typeof createSnappayAdapter>;
const mockedEnqueue = enqueueSnappayOperation as jest.MockedFunction<
  typeof enqueueSnappayOperation
>;

function createHarness(operationOverrides: Record<string, unknown> = {}) {
  const transaction = {
    id: 44,
    external_source: "SnappPay",
    external_id: "ABC1234567",
    TrackId: "provider-payment-token",
    GatewayStatus: "REGISTERED",
  };
  const attempt = {
    id: 11,
    attemptId: "attempt-11",
    Status: "Unknown",
    Gateway: "snappay",
    Amount: 2_200_000,
    providerStatus: "REGISTERED",
    providerReference: "ABC1234567",
    order: {
      id: 22,
      Status: "Started",
      ShippingBarcode: null,
      user: { id: 5 },
      order_items: [
        {
          id: 71,
          Count: 2,
          PerAmount: 100_000,
          ProductTitle: "Product",
          product_variation: {
            id: 81,
            product: {
              product_main_category: { Title: "Category" },
            },
          },
        },
      ],
    },
    contract: {
      id: 33,
      Amount: 220_000,
      contract_transactions: [transaction],
    },
  };
  const operation = {
    id: 88,
    OperationType: "RECONCILE",
    Status: "Processing",
    retryCount: 0,
    metadata: {},
    payment_attempt: { id: 11 },
    ...operationOverrides,
  };
  const operationQuery = {
    findOne: jest.fn().mockResolvedValue(operation),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const attemptQuery = {
    findOne: jest.fn().mockResolvedValue(attempt),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const transactionQuery = {
    update: jest.fn().mockResolvedValue(undefined),
  };
  const strapi = {
    db: {
      connection: {
        raw: jest.fn().mockResolvedValue({ rows: [{ id: operation.id }] }),
      },
      query: jest.fn((uid: string) => {
        if (uid === "api::payment-operation.payment-operation") {
          return operationQuery;
        }
        if (uid === "api::payment-attempt.payment-attempt") {
          return attemptQuery;
        }
        if (uid === "api::contract-transaction.contract-transaction") {
          return transactionQuery;
        }
        throw new Error(`Unexpected query: ${uid}`);
      }),
    },
    log: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    },
  } as any;
  return {
    strapi,
    attempt,
    transaction,
    operation,
    operationQuery,
    attemptQuery,
    transactionQuery,
  };
}

describe("SnappPay operation processing guards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("moves an unresolved operation to manual review when reconciliation is exhausted", async () => {
    const { strapi, operationQuery, attemptQuery } = createHarness({
      retryCount: SNAPPAY_RECONCILIATION_DELAYS_MS.length,
    });
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue({
        successful: true,
        response: { status: "REGISTERED" },
        diagnostic: {
          endpoint: "status",
          httpStatus: 200,
          providerCode: 0,
        },
      }),
    } as any);

    await processSnappayOperation(strapi, 88);

    expect(operationQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 88 },
        data: expect.objectContaining({
          Status: "Unknown",
          nextRunAt: null,
          failureMessage: expect.stringContaining("Automatic reconciliation exhausted"),
        }),
      }),
    );
    expect(attemptQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        // The $ne guard must be part of the UPDATE so it also holds against a
        // concurrent settlement, not just a read-then-write.
        where: { id: 11, Status: { $ne: "Succeeded" } },
        data: expect.objectContaining({
          Status: "Unknown",
          nextAction: "manual_review",
          nextActionAt: null,
          failureCode: "SNAPPAY_RECONCILIATION_EXHAUSTED",
        }),
      }),
    );
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("never downgrades an already-settled attempt from a failure path", async () => {
    const { strapi, attemptQuery } = createHarness({
      retryCount: SNAPPAY_RECONCILIATION_DELAYS_MS.length,
    });
    // Simulate the guarded UPDATE matching no row because the attempt is settled.
    attemptQuery.update.mockResolvedValue(null);
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue({
        successful: true,
        response: { status: "REGISTERED" },
        diagnostic: { endpoint: "status", httpStatus: 200, providerCode: 0 },
      }),
    } as any);

    await processSnappayOperation(strapi, 88);

    expect(strapi.log.warn).toHaveBeenCalledWith(
      "Refused to downgrade a settled SnappPay attempt from a failure path",
      expect.objectContaining({ attemptedStatus: "Unknown" }),
    );
  });

  it("persists the provider and HTTP codes for a rejected admin update", async () => {
    const { strapi, operationQuery } = createHarness({
      OperationType: "UPDATE",
      metadata: {
        operatorAction: true,
        reason: "One unit unavailable",
        actorId: 7,
        changes: [
          {
            orderItemId: 71,
            oldCount: 2,
            newCount: 1,
            restockDelta: 1,
          },
        ],
        newTotalToman: 120_000,
        newDiscountToman: 0,
        newShippingToman: 20_000,
        expectedOldTotalToman: 220_000,
      },
    });
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue({
        successful: true,
        response: { status: "SETTLE" },
        diagnostic: {
          endpoint: "status",
          httpStatus: 200,
          providerCode: 0,
        },
      }),
      update: jest.fn().mockResolvedValue({
        successful: false,
        errorData: {
          errorCode: 1042,
          message: "Amount cannot exceed the original order",
        },
        diagnostic: {
          endpoint: "update",
          httpStatus: 409,
          providerCode: 1042,
        },
      }),
    } as any);

    await processSnappayOperation(strapi, 88);

    expect(operationQuery.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 88 },
        data: expect.objectContaining({
          Status: "Failed",
          providerStatus: "SETTLE",
          httpStatus: 409,
          providerCode: 1042,
          nextRunAt: null,
          failureMessage: expect.stringContaining("SNAPPAY_UPDATE_1042"),
        }),
      }),
    );
  });

  it("recovers a cleared provider token from the fingerprinted redirect URL", async () => {
    const token = "restored-provider-payment-token";
    const { strapi, attempt, transaction, transactionQuery } = createHarness();
    transaction.TrackId = null;
    attempt.redirectUrl = `https://pay.example.test/start?paymentToken=${token}`;
    attempt.providerResponse = {
      tokenFingerprint: displaySnappayFingerprint(
        snappayTokenFingerprint(token),
      ),
    };
    const status = jest.fn().mockResolvedValue({
      successful: true,
      response: { status: "REGISTERED" },
      diagnostic: { endpoint: "status", httpStatus: 200, providerCode: 0 },
    });
    mockedAdapter.mockReturnValue({ status } as any);

    await processSnappayOperation(strapi, 88);

    expect(status).toHaveBeenCalledWith(token);
    expect(transactionQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 44 },
        data: { TrackId: token },
      }),
    );
  });

  it("does not recover SnappPay tokens from an insecure redirect URL", () => {
    expect(
      extractSnappayPaymentTokenFromRedirectUrl(
        "http://pay.example.test/start?paymentToken=secret",
      ),
    ).toBe("");
  });
});
