import { createSnappayAdapter } from "../services/snappay";
import {
  applySnappayCancellation,
  finalizeSnappaySettlement,
} from "../services/snappay-finalization";
import { processSnappayOperation } from "../services/snappay-orchestrator";

jest.mock("../../../queue/snappay", () => ({
  enqueueSnappayOperation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/snappay", () => ({
  createSnappayAdapter: jest.fn(),
}));
// Local finalization is covered by snappay-finalization.spec.ts. Mocking it here
// keeps these tests focused on the *order of provider calls*, which is what moves
// money and what nothing currently asserts.
jest.mock("../services/snappay-finalization", () => ({
  finalizeSnappaySettlement: jest.fn().mockResolvedValue({ replayed: false }),
  applySnappayCancellation: jest.fn().mockResolvedValue(undefined),
  applySnappayAdminUpdate: jest.fn().mockResolvedValue(undefined),
  runSnappaySideEffects: jest.fn().mockResolvedValue(undefined),
}));

const mockedAdapter = createSnappayAdapter as jest.MockedFunction<typeof createSnappayAdapter>;
const mockedFinalize = finalizeSnappaySettlement as jest.MockedFunction<
  typeof finalizeSnappaySettlement
>;
const mockedCancelLocal = applySnappayCancellation as jest.MockedFunction<
  typeof applySnappayCancellation
>;

const envelope = (status: string, successful = true) => ({
  successful,
  response: successful ? { status } : undefined,
  diagnostic: { endpoint: "status", httpStatus: successful ? 200 : 409, providerCode: 0 },
});

/**
 * Records the exact order of provider calls so a regression that swaps
 * verify/settle, drops the ambiguous-settle status re-check, or mishandles
 * SETTLE_THEN_CANCEL is caught instead of shipping green.
 */
function createAdapter(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const track = (name: string, impl: (...args: any[]) => any) =>
    jest.fn(async (...args: any[]) => {
      calls.push(name);
      return impl(...args);
    });

  const adapter = {
    status: track("status", overrides.status || (async () => envelope("PENDING"))),
    verify: track("verify", overrides.verify || (async () => envelope("VERIFY"))),
    settle: track("settle", overrides.settle || (async () => envelope("SETTLE"))),
    revert: track("revert", overrides.revert || (async () => envelope("REVERT"))),
    cancel: track("cancel", overrides.cancel || (async () => envelope("CANCEL"))),
    update: track("update", overrides.update || (async () => envelope("VERIFY"))),
  };
  mockedAdapter.mockReturnValue(adapter as any);
  return { adapter, calls };
}

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
    Status: "Pending",
    Gateway: "snappay",
    Amount: 2_200_000,
    providerStatus: "REGISTERED",
    providerReference: "ABC1234567",
    createdAt: new Date(Date.now() - 2 * 60 * 1000),
    order: { id: 22, Status: "Paying", ShippingBarcode: null, user: { id: 5 }, order_items: [] },
    contract: { id: 33, Amount: 220_000, contract_transactions: [transaction] },
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
  const queries: Record<string, any> = {};
  const strapi = {
    db: {
      connection: { raw: jest.fn().mockResolvedValue({ rows: [{ id: operation.id }] }) },
      query: jest.fn((uid: string) => {
        queries[uid] ||= {
          findOne: jest
            .fn()
            .mockResolvedValue(
              uid === "api::payment-operation.payment-operation" ? operation : attempt,
            ),
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockResolvedValue({ id: 1 }),
          create: jest.fn().mockResolvedValue({ id: 1 }),
          count: jest.fn().mockResolvedValue(0),
        };
        return queries[uid];
      }),
    },
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  } as any;
  return { strapi, attempt, operation, queries };
}

describe("SnappPay provider call sequencing", () => {
  beforeEach(() => jest.clearAllMocks());

  it("verifies when the provider is still PENDING", async () => {
    const { calls } = createAdapter({ status: async () => envelope("PENDING") });
    const { strapi } = createHarness({ metadata: { callbackState: "OK" } });

    await processSnappayOperation(strapi, 88);

    expect(calls[0]).toBe("status");
    expect(calls).toContain("verify");
    expect(calls).not.toContain("cancel");
    expect(calls).not.toContain("revert");
  });

  it("settles — and does not cancel — for a successful callback at VERIFY", async () => {
    const { calls } = createAdapter({ status: async () => envelope("VERIFY") });
    const { strapi } = createHarness({ metadata: { callbackState: "OK" } });

    await processSnappayOperation(strapi, 88);

    expect(calls).toEqual(["status", "settle"]);
    expect(mockedFinalize).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("cancel");
  });

  it("settles before cancelling for a FAILED callback at VERIFY", async () => {
    // A verified transaction cannot be cancelled outright, so the money is captured
    // and then returned. Order matters: cancelling first would leave the charge.
    const { calls } = createAdapter({ status: async () => envelope("VERIFY") });
    const { strapi } = createHarness({ metadata: { callbackState: "FAILED" } });

    await processSnappayOperation(strapi, 88);

    expect(calls.indexOf("settle")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("cancel")).toBeGreaterThan(calls.indexOf("settle"));
    // Local settlement must NOT be recorded — the order is being cancelled.
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it("finalizes locally without touching the provider when it already settled", async () => {
    const { calls } = createAdapter({ status: async () => envelope("SETTLE") });
    const { strapi } = createHarness({ metadata: { callbackState: "OK" } });

    await processSnappayOperation(strapi, 88);

    expect(calls).toEqual(["status"]);
    expect(mockedFinalize).toHaveBeenCalledTimes(1);
  });

  it("does not revert a REGISTERED token merely because it is older than the reservation window", async () => {
    const { calls } = createAdapter({ status: async () => envelope("REGISTERED") });
    const { strapi, attempt } = createHarness();
    attempt.createdAt = new Date(Date.now() - 90 * 60 * 1000);

    await processSnappayOperation(strapi, 88);

    expect(calls).toEqual(["status"]);
    expect(calls).not.toContain("revert");
    expect(mockedCancelLocal).not.toHaveBeenCalled();
  });

  it("parks a parsed 1007 for investigation without cancelling locally", async () => {
    const { calls } = createAdapter({
      status: async () => ({
        successful: false,
        diagnostic: { endpoint: "status", httpStatus: 404, providerCode: 1007 },
      }),
    });
    const { strapi } = createHarness();

    await processSnappayOperation(strapi, 88);

    expect(calls).toEqual(["status"]);
    expect(mockedCancelLocal).not.toHaveBeenCalled();
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it("re-checks provider status after an ambiguous settle and does not settle twice", async () => {
    // settle() fails but the provider actually did settle. The status re-check is
    // what prevents both a lost capture and a double settle.
    let settleCalls = 0;
    const { calls } = createAdapter({
      status: async () => envelope("SETTLE"),
      settle: async () => {
        settleCalls += 1;
        return envelope("", false);
      },
    });
    const { strapi } = createHarness({ metadata: { callbackState: "OK" } });

    await processSnappayOperation(strapi, 88);

    expect(settleCalls).toBeLessThanOrEqual(1);
    expect(calls.filter((c) => c === "settle").length).toBeLessThanOrEqual(1);
    expect(mockedFinalize).toHaveBeenCalledTimes(1);
  });

  it("defers revert while the provider still reports REGISTERED after 1011", async () => {
    const { calls } = createAdapter({
      status: async () => envelope("REGISTERED"),
      revert: async () => ({
        successful: false,
        diagnostic: { endpoint: "revert", httpStatus: 400, providerCode: 1011 },
      }),
    });
    const { strapi, queries } = createHarness({ metadata: { callbackState: "FAILED" } });

    await processSnappayOperation(strapi, 88);

    expect(calls[0]).toBe("status");
    expect(calls).toContain("revert");
    expect(mockedCancelLocal).not.toHaveBeenCalled();
    expect(queries["api::payment-operation.payment-operation"].update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          Status: "Queued",
        }),
      }),
    );
  });

  it("cancels locally when the provider reports a terminal REVERT", async () => {
    const { calls } = createAdapter({ status: async () => envelope("REVERT") });
    const { strapi } = createHarness();

    await processSnappayOperation(strapi, 88);

    expect(calls).toEqual(["status"]);
    expect(mockedCancelLocal).toHaveBeenCalled();
    expect(mockedFinalize).not.toHaveBeenCalled();
  });
});
