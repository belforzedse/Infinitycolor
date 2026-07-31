import { enqueueSnappayOperation } from "../../../queue/snappay";
import {
  acceptSnappayCallback,
} from "../services/snappay-orchestrator";
import {
  generateSnappayCallbackNonce,
  hashSnappayCallbackNonce,
} from "../services/snappay-security";

jest.mock("../../../queue/snappay", () => ({
  enqueueSnappayOperation: jest.fn().mockResolvedValue(undefined),
}));

const mockedEnqueue = enqueueSnappayOperation as jest.MockedFunction<
  typeof enqueueSnappayOperation
>;

function createHarness(input?: {
  amount?: number;
  callbackNonceHash?: string | null;
  legacy?: boolean;
}) {
  const attempt = {
    id: 11,
    attemptId: "attempt-11",
    Status: "Redirected",
    Gateway: "snappay",
    Amount: input?.amount ?? 1_200_000,
    providerReference: "ABC1234567",
    callbackNonceHash: input?.callbackNonceHash,
    quoteSnapshot: input?.legacy ? { legacy: true } : {},
    order: { id: 22, user: { id: 5 }, order_items: [] },
    contract: {
      id: 33,
      contract_transactions: [
        {
          id: 44,
          external_source: "SnappPay",
          external_id: "ABC1234567",
        },
      ],
    },
  };
  const attemptUpdate = jest.fn().mockResolvedValue(attempt);
  const operationCreate = jest.fn().mockImplementation(({ data }) => ({
    id: 55,
    retryCount: 0,
    ...data,
  }));
  const queries: Record<string, any> = {
    "api::payment-attempt.payment-attempt": {
      findOne: jest.fn().mockResolvedValue(attempt),
      update: attemptUpdate,
    },
    "api::payment-operation.payment-operation": {
      findOne: jest.fn().mockResolvedValue(null),
      create: operationCreate,
      update: jest.fn(),
    },
  };
  const strapi = {
    db: { query: jest.fn((uid: string) => queries[uid]) },
    log: {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    },
  } as any;
  return { strapi, attemptUpdate, operationCreate };
}

describe("acceptSnappayCallback correlation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FRONTEND_BASE_URL = "https://storefront.test.invalid";
  });

  it("accepts a correlated callback and queues provider reconciliation", async () => {
    const nonce = generateSnappayCallbackNonce();
    const { strapi, attemptUpdate, operationCreate } = createHarness({
      callbackNonceHash: hashSnappayCallbackNonce(nonce),
    });

    const result = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "OK",
      amount: 1_200_000,
      nonce,
    });

    expect(result).toEqual(
      expect.objectContaining({ accepted: true, orderId: 22 }),
    );
    expect(attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 11 },
        data: expect.objectContaining({
          Status: "Pending",
          providerStatus: "CALLBACK_OK",
          nextAction: "verify",
        }),
      }),
    );
    expect(operationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: "reconcile:11",
          OperationType: "RECONCILE",
          payment_attempt: 11,
          order: 22,
          contract_transaction: 44,
        }),
      }),
    );
    expect(mockedEnqueue).toHaveBeenCalledWith(55, 0, 0);
  });

  it.each([
    ["wrong nonce", generateSnappayCallbackNonce(), 1_200_000],
    ["wrong amount", null, 1_200_001],
  ])("rejects %s without mutating payment state", async (_name, candidate, amount) => {
    const nonce = generateSnappayCallbackNonce();
    const { strapi, attemptUpdate, operationCreate } = createHarness({
      callbackNonceHash: hashSnappayCallbackNonce(nonce),
    });

    const result = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "OK",
      amount,
      nonce: candidate || nonce,
    });

    expect(result.accepted).toBe(false);
    expect(result.errorCode).toBe("SNAPPAY_CALLBACK_MISMATCH");
    expect(attemptUpdate).not.toHaveBeenCalled();
    expect(operationCreate).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("rejects nonce-less legacy callbacks and leaves recovery to the scheduled reconciler", async () => {
    const { strapi, attemptUpdate, operationCreate } = createHarness({
      legacy: true,
      callbackNonceHash: null,
    });

    const result = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "FAILED",
      amount: 1_200_000,
      nonce: "",
    });

    expect(result.accepted).toBe(false);
    expect(result.errorCode).toBe("SNAPPAY_CALLBACK_MISMATCH");
    expect(attemptUpdate).not.toHaveBeenCalled();
    expect(operationCreate).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});
