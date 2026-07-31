import { enqueueSnappayOperation } from "../../../queue/snappay";
import { sweepSnappayOperations } from "../services/snappay-orchestrator";

jest.mock("../../../queue/snappay", () => ({
  enqueueSnappayOperation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/snappay", () => ({
  createSnappayAdapter: jest.fn(),
}));

const mockedEnqueue = enqueueSnappayOperation as jest.MockedFunction<
  typeof enqueueSnappayOperation
>;

const OPERATION_UID = "api::payment-operation.payment-operation";
const ATTEMPT_UID = "api::payment-attempt.payment-attempt";

/**
 * A settled attempt whose FINALIZE_EFFECTS operation never made it onto the
 * queue: the customer paid, but their cart was never cleared and the revenue was
 * never reported. This is reachable three ways — the enqueue throwing, the worker
 * dying between the settlement commit and the enqueue, and the replay
 * short-circuit in processSnappayOperation returning early.
 */
function createHarness(strandedAttempts: any[]) {
  const transaction = {
    id: 44,
    external_source: "SnappPay",
    external_id: "ABC1234567",
    TrackId: "provider-payment-token",
    GatewayStatus: "SETTLE",
  };
  const operationCreate = jest.fn().mockResolvedValue({ id: 99, Status: "Queued" });
  const operationQuery = {
    findOne: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    create: operationCreate,
    update: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(0),
  };
  const attemptQuery = {
    findMany: jest.fn().mockResolvedValue(strandedAttempts),
    findOne: jest.fn().mockImplementation(async ({ where }: any) => {
      const match = strandedAttempts.find((a) => a.id === where?.id);
      if (!match) return null;
      return {
        ...match,
        order: { id: 22, Status: "Started", user: { id: 5 }, order_items: [] },
        contract: { id: 33, Amount: 220_000, contract_transactions: [transaction] },
      };
    }),
    update: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(0),
  };
  const strapi = {
    db: {
      connection: { raw: jest.fn().mockResolvedValue({ rows: [] }) },
      query: jest.fn((uid: string) => {
        if (uid === OPERATION_UID) return operationQuery;
        if (uid === ATTEMPT_UID) return attemptQuery;
        throw new Error(`Unexpected query: ${uid}`);
      }),
    },
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  } as any;
  return { strapi, operationQuery, attemptQuery, operationCreate };
}

describe("SnappPay stranded side-effect recovery", () => {
  beforeEach(() => jest.clearAllMocks());

  it("re-queues side effects for a settled attempt that never ran them", async () => {
    const { strapi, attemptQuery, operationCreate } = createHarness([
      {
        id: 11,
        attemptId: "attempt-11",
        Status: "Succeeded",
        Gateway: "snappay",
        providerReference: "ABC1234567",
        sideEffectsCompletedAt: null,
      },
    ]);

    await sweepSnappayOperations(strapi);

    expect(attemptQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          Gateway: "snappay",
          Status: "Succeeded",
          sideEffectsCompletedAt: null,
        }),
      }),
    );
    expect(operationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          OperationType: "FINALIZE_EFFECTS",
          idempotencyKey: "effects:11",
        }),
      }),
    );
    expect(strapi.log.warn).toHaveBeenCalledWith(
      "Re-queued SnappPay side effects for settled attempts",
      { count: 1 },
    );
  });

  it("does nothing when every settled attempt already ran its side effects", async () => {
    const { strapi, operationCreate } = createHarness([]);

    await sweepSnappayOperations(strapi);

    expect(operationCreate).not.toHaveBeenCalled();
    expect(strapi.log.warn).not.toHaveBeenCalledWith(
      "Re-queued SnappPay side effects for settled attempts",
      expect.anything(),
    );
  });

  it("keeps sweeping operations when side-effect recovery fails", async () => {
    const { strapi, attemptQuery } = createHarness([]);
    attemptQuery.findMany.mockRejectedValue(new Error("db unavailable"));

    await expect(sweepSnappayOperations(strapi)).resolves.toEqual(
      expect.objectContaining({ queued: expect.any(Number) }),
    );
    expect(strapi.log.error).toHaveBeenCalledWith(
      "Failed to scan for stranded SnappPay side effects",
      expect.objectContaining({ error: expect.stringContaining("db unavailable") }),
    );
  });
});
