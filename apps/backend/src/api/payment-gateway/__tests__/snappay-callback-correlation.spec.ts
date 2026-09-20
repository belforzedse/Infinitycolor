import { enqueueSnappayOperation } from "../../../queue/snappay";
import {
  acceptSnappayCallback,
  requestSnappayCustomerAbandon,
  requestSnappayReconciliation,
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
  walletAmount?: number;
  gatewayAmount?: number;
  callbackNonceHash?: string | null;
  legacy?: boolean;
  providerReference?: string;
  providerResponse?: Record<string, unknown>;
  providerStatus?: string;
  nextAction?: string;
  existingOperation?: {
    id: number;
    Status: string;
    retryCount: number;
    nextRunAt: Date | null;
    OperationType?: string;
    metadata?: Record<string, unknown>;
  };
}) {
  const attempt = {
    id: 11,
    attemptId: "attempt-11",
    Status: "Redirected",
    Gateway: "snappay",
    Amount: input?.amount ?? 1_200_000,
    WalletAmount: input?.walletAmount,
    GatewayAmount: input?.gatewayAmount,
    providerReference: input?.providerReference ?? "ABC1234567",
    callbackNonceHash: input?.callbackNonceHash,
    providerStatus: input?.providerStatus,
    nextAction: input?.nextAction,
    providerResponse: input?.providerResponse || {},
    quoteSnapshot: input?.legacy ? { legacy: true } : {},
    order: { id: 22, user: { id: 5 }, order_items: [] },
    contract: {
      id: 33,
      contract_transactions: [
        {
          id: 44,
          external_source: "SnappPay",
          external_id: input?.providerReference ?? "ABC1234567",
        },
      ],
    },
  };
  const existing = input?.existingOperation;
  const attemptUpdate = jest.fn().mockResolvedValue(attempt);
  const operationCreate = jest.fn().mockImplementation(({ data }) => ({
    id: 55,
    retryCount: 0,
    ...data,
  }));
  const queries: Record<string, any> = {
    "api::payment-attempt.payment-attempt": {
      findOne: jest
        .fn()
        .mockImplementation(async ({ where }: { where?: Record<string, unknown> }) => {
          if (where?.providerReference && where.providerReference !== attempt.providerReference) {
            return null;
          }
          if (where?.id && Number(where.id) !== attempt.id) {
            return null;
          }
          return attempt;
        }),
      update: attemptUpdate,
    },
    "api::payment-operation.payment-operation": {
      findOne: jest.fn().mockResolvedValue(existing || null),
      create: operationCreate,
      update: jest.fn(),
    },
  };
  const raw = jest.fn(async (sql: string) => {
    if (sql.includes("previousGeneration")) {
      return { rows: [{ id: 11 }] };
    }
    if (sql.includes("status = 'Unknown'") && sql.includes("next_run_at IS NULL")) {
      return existing?.Status === "Unknown" && existing.nextRunAt == null
        ? { rows: [{ id: existing.id, retry_count: existing.retryCount }] }
        : { rows: [] };
    }
    if (sql.includes("status = 'Queued'") && sql.includes("next_run_at >")) {
      const dueAt = existing?.nextRunAt ? existing.nextRunAt.getTime() : 0;
      return existing?.Status === "Queued" && dueAt > Date.now()
        ? { rows: [{ id: existing.id, retry_count: existing.retryCount }] }
        : { rows: [] };
    }
    if (sql.includes("status IN ('Queued', 'Processing')")) {
      return existing?.Status === "Queued" || existing?.Status === "Processing"
        ? { rows: [{ id: existing.id, status: existing.Status }] }
        : { rows: [] };
    }
    return { rows: [{ id: 11 }] };
  });
  const strapi = {
    db: {
      query: jest.fn((uid: string) => queries[uid]),
      connection: { raw },
    },
    log: {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    },
  } as any;
  return { strapi, attemptUpdate, operationCreate, raw };
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

    expect(result).toEqual(expect.objectContaining({ accepted: true, orderId: 22 }));
    expect(attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 11, Status: { $ne: "Succeeded" } },
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

  it("correlates a mixed callback against the SnappPay leg, not the full order", async () => {
    const nonce = generateSnappayCallbackNonce();
    const { strapi, attemptUpdate } = createHarness({
      amount: 1_200_000,
      walletAmount: 350_000,
      gatewayAmount: 850_000,
      callbackNonceHash: hashSnappayCallbackNonce(nonce),
    });

    const accepted = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "OK",
      amount: 850_000,
      nonce,
    });
    expect(accepted.accepted).toBe(true);
    expect(attemptUpdate).toHaveBeenCalled();

    const rejected = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "OK",
      amount: 1_200_000,
      nonce,
    });
    expect(rejected).toMatchObject({
      accepted: false,
      errorCode: "SNAPPAY_CALLBACK_MISMATCH",
    });
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

  it("accepts a late callback for a previous generation transaction id", async () => {
    const previousNonce = generateSnappayCallbackNonce();
    const currentNonce = generateSnappayCallbackNonce();
    const { strapi, attemptUpdate, operationCreate, raw } = createHarness({
      providerReference: "NEWNEWNEW1",
      callbackNonceHash: hashSnappayCallbackNonce(currentNonce),
      providerResponse: {
        generation: {
          seq: 2,
          transactionId: "NEWNEWNEW1",
          dispatchedAt: new Date().toISOString(),
          callbackNonceHash: hashSnappayCallbackNonce(currentNonce),
        },
        previousGeneration: {
          seq: 1,
          transactionId: "ABC1234567",
          dispatchedAt: new Date().toISOString(),
          callbackNonceHash: hashSnappayCallbackNonce(previousNonce),
        },
      },
    });

    const result = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "OK",
      amount: 1_200_000,
      nonce: previousNonce,
    });

    expect(result.accepted).toBe(true);
    expect(attemptUpdate).not.toHaveBeenCalled();
    expect(raw.mock.calls.some(([sql]: [string]) => sql.includes("previousGeneration"))).toBe(true);
    expect(operationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: "reconcile:11:previous:1",
          metadata: expect.objectContaining({ previousGeneration: true }),
        }),
      }),
    );
  });

  it("requeues a parked reconcile after a validated callback without creating a second operation", async () => {
    const nonce = generateSnappayCallbackNonce();
    const { strapi, operationCreate } = createHarness({
      callbackNonceHash: hashSnappayCallbackNonce(nonce),
      existingOperation: {
        id: 55,
        Status: "Unknown",
        retryCount: 2,
        nextRunAt: null,
        OperationType: "RECONCILE",
      },
    });

    const result = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "OK",
      amount: 1_200_000,
      nonce,
    });

    expect(result.accepted).toBe(true);
    expect(operationCreate).not.toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalledWith(55, 2, 0);
  });

  it("pulls a delayed queued reconcile forward after CALLBACK_OK", async () => {
    const nonce = generateSnappayCallbackNonce();
    const { strapi, operationCreate } = createHarness({
      callbackNonceHash: hashSnappayCallbackNonce(nonce),
      existingOperation: {
        id: 55,
        Status: "Queued",
        retryCount: 1,
        nextRunAt: new Date(Date.now() + 5 * 60 * 1000),
        OperationType: "RECONCILE",
      },
    });

    const result = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "OK",
      amount: 1_200_000,
      nonce,
    });

    expect(result.accepted).toBe(true);
    expect(operationCreate).not.toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalledWith(55, 1, 0, { jobIdSalt: "pull" });
  });

  it("does not reset a running reconcile or enqueue a competing job", async () => {
    const nonce = generateSnappayCallbackNonce();
    const { strapi, operationCreate } = createHarness({
      callbackNonceHash: hashSnappayCallbackNonce(nonce),
      existingOperation: {
        id: 55,
        Status: "Processing",
        retryCount: 1,
        nextRunAt: new Date(),
        OperationType: "RECONCILE",
      },
    });

    const result = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "OK",
      amount: 1_200_000,
      nonce,
    });

    expect(result.accepted).toBe(true);
    expect(operationCreate).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("ignores a failed callback once successful payment evidence is established", async () => {
    const nonce = generateSnappayCallbackNonce();
    const { strapi, attemptUpdate, operationCreate } = createHarness({
      callbackNonceHash: hashSnappayCallbackNonce(nonce),
      providerStatus: "CALLBACK_OK",
      nextAction: "verify",
    });

    const result = await acceptSnappayCallback(strapi, {
      transactionId: "ABC1234567",
      state: "FAILED",
      amount: 1_200_000,
      nonce,
    });

    expect(result.accepted).toBe(true);
    expect(attemptUpdate).not.toHaveBeenCalled();
    expect(operationCreate).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});

describe("requestSnappayReconciliation pull-forward", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("pulls a delayed queued reconcile forward instead of no-oping", async () => {
    const { strapi, operationCreate } = createHarness({
      existingOperation: {
        id: 55,
        Status: "Queued",
        retryCount: 1,
        nextRunAt: new Date(Date.now() + 5 * 60 * 1000),
        OperationType: "RECONCILE",
      },
    });

    await requestSnappayReconciliation(strapi, 22, "customer_request");

    expect(operationCreate).not.toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalledWith(55, 1, 0, { jobIdSalt: "pull" });
  });

  it("does not enqueue a competing job while reconcile is already processing", async () => {
    const { strapi, operationCreate } = createHarness({
      existingOperation: {
        id: 55,
        Status: "Processing",
        retryCount: 1,
        nextRunAt: new Date(),
        OperationType: "RECONCILE",
      },
    });

    await requestSnappayReconciliation(strapi, 22, "customer_request");

    expect(operationCreate).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});

/**
 * The shopper's "I did not pay" claim, at the door.
 *
 * The state machine ignores the claim once an `OK` callback is on the operation,
 * but the claim must also be refused *visibly*: both triggers tell the shopper
 * whether a release is coming, and a paying customer must not be told one is.
 */
describe("requestSnappayCustomerAbandon", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FRONTEND_BASE_URL = "https://storefront.test.invalid";
  });

  it("records the claim for an attempt with no successful return", async () => {
    const { strapi, operationCreate } = createHarness();

    await expect(requestSnappayCustomerAbandon(strapi, 22)).resolves.toEqual(
      expect.objectContaining({ accepted: true }),
    );
    expect(operationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: "reconcile:11",
          metadata: expect.objectContaining({ customerAbandoned: true }),
        }),
      }),
    );
  });

  it.each([
    ["providerStatus CALLBACK_OK", { providerStatus: "CALLBACK_OK" }],
    ["nextAction verify", { nextAction: "verify" }],
  ])("drops the claim behind the shopper's own OK return (%s)", async (_label, overrides) => {
    // Mirrors the predicate `acceptSnappayCallback` uses to discard a FAILED
    // callback over established success.
    const { strapi, operationCreate } = createHarness(overrides);

    await expect(requestSnappayCustomerAbandon(strapi, 22)).resolves.toEqual(
      expect.objectContaining({ accepted: false }),
    );
    const metadata = operationCreate.mock.calls[0][0].data.metadata;
    expect(metadata).not.toHaveProperty("customerAbandoned");
    // The reconcile itself is still queued — the shopper's poll must keep the
    // settlement moving even though the cancellation was refused.
    expect(operationCreate).toHaveBeenCalled();
  });

  it("drops the claim behind an OK callback the worker has already polled past", async () => {
    // `updateProviderObservation` overwrites `CALLBACK_OK` with the first
    // non-UNKNOWN status read, so one worker pass leaves the attempt reading
    // plain PENDING while the operation still carries the callback. The
    // metadata is what `decideSnappayRecovery` consults, so it is what decides
    // here too — otherwise the shopper is told a release is coming that the
    // state machine will refuse.
    const { strapi, raw } = createHarness({
      providerStatus: "PENDING",
      nextAction: "reconcile",
      existingOperation: {
        id: 55,
        Status: "Queued",
        retryCount: 1,
        nextRunAt: new Date(Date.now() + 5 * 60 * 1000),
        metadata: { callbackState: "OK" },
      },
    });

    await expect(requestSnappayCustomerAbandon(strapi, 22)).resolves.toEqual(
      expect.objectContaining({ accepted: false }),
    );
    for (const [, bindings] of raw.mock.calls) {
      expect(JSON.stringify(bindings ?? [])).not.toContain("customerAbandoned");
    }
  });

  it("reports nothing recorded for an already resolved attempt", async () => {
    const { strapi, operationCreate } = createHarness();
    strapi.db.query("api::payment-attempt.payment-attempt").findOne.mockResolvedValue({
      id: 11,
      Status: "Succeeded",
      Gateway: "snappay",
      order: { id: 22 },
    });

    await expect(requestSnappayCustomerAbandon(strapi, 22)).resolves.toEqual(
      expect.objectContaining({ accepted: false }),
    );
    expect(operationCreate).not.toHaveBeenCalled();
  });

  it("merges the claim onto a reconcile that is already queued", async () => {
    // The result page's own poll creates this row first, so the claim almost
    // always arrives as an annotation rather than a fresh operation.
    const { strapi, raw } = createHarness({
      existingOperation: { id: 55, Status: "Processing", retryCount: 1, nextRunAt: null },
    });

    await expect(requestSnappayCustomerAbandon(strapi, 22)).resolves.toEqual(
      expect.objectContaining({ accepted: true }),
    );
    const annotate = raw.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("status IN ('Queued', 'Processing')"),
    );
    expect(annotate).toBeDefined();
    expect(JSON.stringify(annotate[1])).toContain("customerAbandoned");
  });
});
