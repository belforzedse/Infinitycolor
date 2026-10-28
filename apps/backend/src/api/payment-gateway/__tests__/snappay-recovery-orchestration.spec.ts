/**
 * Orchestrator-level proof for the staged recovery paths.
 *
 * The case that shapes all of this is real production data: a status read at
 * +2 minutes answered 1007, the shopper carried on, the OK callback arrived,
 * and the order settled. That happened to 56 of 481 settled attempts in four
 * days. Every assertion about "does not release" below is about those
 * customers.
 */
process.env.SNAPPAY_BASE_URL = "https://snappay.test.invalid";
process.env.SNAPPAY_CLIENT_ID = "test-snappay-client-id";
process.env.SNAPPAY_CLIENT_SECRET = "test-secret";
process.env.SNAPPAY_USERNAME = "test-user";
process.env.SNAPPAY_PASSWORD = "test-pass";
process.env.SNAPPAY_RETURN_URL = "https://storefront.test.invalid/api/snapp/return";

import { createHash } from "node:crypto";
import { enqueueSnappayOperation } from "../../../queue/snappay";
import { createSnappayAdapter } from "../services/snappay";
import { applySnappayCancellation } from "../services/snappay-finalization";
import { processSnappayOperation } from "../services/snappay-orchestrator";
import {
  __resetRecoveryReadinessForTests,
  __setRecoveryReadinessForTests,
  type RecoveryMode,
} from "../services/snappay-recovery-mode";

jest.mock("../../../queue/snappay", () => ({
  enqueueSnappayOperation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/snappay", () => {
  const actual = jest.requireActual("../services/snappay");
  return { ...actual, createSnappayAdapter: jest.fn() };
});
jest.mock("../services/snappay-category-mapper", () => ({
  mapToSnappayCategory: jest.fn().mockResolvedValue("OTHER"),
}));
jest.mock("../services/snappay-finalization", () => ({
  applySnappayCancellation: jest.fn().mockResolvedValue({ replayed: false }),
  finalizeSnappaySettlement: jest.fn().mockResolvedValue(undefined),
  applySnappayAdminUpdate: jest.fn().mockResolvedValue(undefined),
  runSnappaySideEffects: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@sentry/node", () => ({ captureMessage: jest.fn() }));

const mockedAdapter = createSnappayAdapter as jest.MockedFunction<typeof createSnappayAdapter>;
const mockedEnqueue = enqueueSnappayOperation as jest.MockedFunction<
  typeof enqueueSnappayOperation
>;
const mockedCancel = applySnappayCancellation as jest.MockedFunction<
  typeof applySnappayCancellation
>;

const TOKEN = "provider-payment-token";
const MINUTE = 60 * 1000;
const PROVIDER_HOST = "snappay.test.invalid";
const CLIENT_FINGERPRINT = createHash("sha256")
  .update("test-snappay-client-id")
  .digest("hex")
  .slice(0, 12);

type EvidenceRecord = Record<string, any>;

type HarnessOptions = {
  attempt?: Record<string, unknown>;
  order?: Record<string, unknown>;
  operation?: Record<string, unknown>;
  generation?: Record<string, unknown>;
  /** Prior `not_found_read` rows already in the evidence table. */
  priorReads?: Array<{ observedAtMs: number; tokenAgeMs: number }>;
  priorEvidence?: EvidenceRecord[];
  tokenAgeMs?: number;
  releasedInWindow?: number;
  releasedWalletIrr?: number;
};

function createHarness(options: HarnessOptions = {}) {
  const tokenAgeMs = options.tokenAgeMs ?? 2 * MINUTE;
  const evidence: EvidenceRecord[] = [...(options.priorEvidence ?? [])];
  let nextEvidenceId = 500;

  const transaction = {
    id: 44,
    external_source: "SnappPay",
    external_id: "ABC1234567",
    TrackId: TOKEN,
    GatewayStatus: "PENDING",
  };
  const attempt: any = {
    id: 11,
    attemptId: "attempt-11",
    Status: "Unknown",
    Gateway: "snappay",
    Amount: 10_000_000,
    WalletAmount: 3_000_000,
    GatewayAmount: 7_000_000,
    providerStatus: "PENDING",
    providerReference: "ABC1234567",
    createdAt: new Date(Date.now() - tokenAgeMs),
    redirectedAt: new Date(Date.now() - tokenAgeMs),
    providerResponse: {
      tokenAttemptSeq: 1,
      generation: {
        seq: 1,
        transactionId: "ABC1234567",
        dispatchedAt: new Date(Date.now() - tokenAgeMs).toISOString(),
        paymentToken: TOKEN,
        paymentTokenFingerprint: "fp-1",
        providerHost: PROVIDER_HOST,
        clientIdFingerprint: CLIENT_FINGERPRINT,
        ...(options.generation ?? {}),
      },
    },
    order: {
      id: 22,
      Status: "Paying",
      ReservationStatus: "Reserved",
      user: { id: 5 },
      order_items: [],
      ...(options.order ?? {}),
    },
    contract: { id: 33, Amount: 1_000_000, contract_transactions: [transaction] },
    ...(options.attempt ?? {}),
  };
  const operation: any = {
    id: 88,
    OperationType: "RECONCILE",
    Status: "Processing",
    retryCount: 0,
    metadata: {},
    payment_attempt: { id: 11 },
    ...(options.operation ?? {}),
  };

  const operationQuery = {
    findOne: jest.fn().mockResolvedValue(operation),
    update: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue({ id: 99 }),
  };
  const attemptQuery = {
    findOne: jest.fn().mockResolvedValue(attempt),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const evidenceQuery = {
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: (nextEvidenceId += 1),
        ...data,
        attempt_id: data.attemptId,
        order_id: data.orderId,
        provider_status: data.providerStatus,
        provider_code: data.providerCode,
        http_status: data.httpStatus,
        callback_state: data.callbackState,
        token_age_ms: data.tokenAgeMs,
        wallet_amount_irr: data.walletAmountIrr,
        observed_at: data.observedAt ?? new Date(),
        created_at: new Date(),
      };
      evidence.push(row);
      return row;
    }),
  };

  const priorReadRows = (options.priorReads ?? []).map((read, index) => ({
    id: 100 + index,
    attempt_id: 11,
    order_id: 22,
    kind: "not_found_read",
    mode: "shadow",
    decision: "observed",
    token_age_ms: read.tokenAgeMs,
    observed_at: new Date(read.observedAtMs),
    created_at: new Date(read.observedAtMs),
  }));

  const raw = jest.fn(async (sql: string) => {
    if (sql.includes("payment_attempt_evidence")) {
      if (sql.includes("decision = 'observed'") && sql.includes("kind = ?")) {
        return { rows: priorReadRows };
      }
      if (sql.includes("SUM(wallet_amount_irr)")) {
        return { rows: [{ total: options.releasedWalletIrr ?? 0 }] };
      }
      if (sql.includes("COUNT(*)::int AS count")) {
        return { rows: [{ count: options.releasedInWindow ?? 0 }] };
      }
      if (sql.includes("ORDER BY id ASC")) {
        return { rows: [...priorReadRows, ...evidence] };
      }
      return { rows: [] };
    }
    // Everything else is the operation-claim UPDATE and friends, which signal
    // success by returning the row they touched.
    return { rows: [{ id: operation.id }] };
  });

  const strapi = {
    db: {
      connection: { raw },
      query: jest.fn((uid: string) => {
        if (uid === "api::payment-operation.payment-operation") return operationQuery;
        if (uid === "api::payment-attempt.payment-attempt") return attemptQuery;
        if (uid === "api::contract-transaction.contract-transaction") {
          return { update: jest.fn().mockResolvedValue(undefined) };
        }
        if (uid === "api::payment-attempt-evidence.payment-attempt-evidence") {
          return evidenceQuery;
        }
        return { update: jest.fn().mockResolvedValue(undefined), findOne: jest.fn() };
      }),
    },
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  } as any;

  return { strapi, attempt, operation, operationQuery, attemptQuery, evidence };
}

const statusReply = (overrides: Record<string, any> = {}) => ({
  successful: false,
  diagnostic: { endpoint: "status", httpStatus: 404, providerCode: 1007 },
  ...overrides,
});

const okStatus = (status: string) => ({
  successful: true,
  response: { status },
  diagnostic: { endpoint: "status", httpStatus: 200, providerCode: 0 },
});

const setModes = (modes: Partial<Record<"not_found" | "registered" | "late_success", RecoveryMode>>) => {
  __setRecoveryReadinessForTests({
    evidenceImmutable: true,
    evidenceDeduplicated: true,
    paths: {
      not_found: {
        configured: modes.not_found ?? "off",
        effective: modes.not_found ?? "off",
        blockedBy: [],
      },
      registered: {
        configured: modes.registered ?? "off",
        effective: modes.registered ?? "off",
        blockedBy: [],
      },
      late_success: {
        configured: modes.late_success ?? "shadow",
        effective: modes.late_success ?? "shadow",
        blockedBy: [],
      },
    },
  } as any);
};

const evidenceOf = (rows: EvidenceRecord[], kind: string) =>
  rows.filter((row) => row.kind === kind);

beforeEach(() => {
  jest.clearAllMocks();
  __resetRecoveryReadinessForTests();
  delete process.env.SNAPPAY_AUTO_RELEASE_MAX_WALLET_IRR_PER_24H;
  delete process.env.SNAPPAY_AUTO_RELEASE_MAX_SINGLE_WALLET_IRR;
});

afterEach(() => {
  __resetRecoveryReadinessForTests();
});

describe("the production case: an early 1007 that later settles", () => {
  it("never releases on the first 1007, in any mode", async () => {
    for (const mode of ["off", "shadow", "enforce"] as const) {
      jest.clearAllMocks();
      setModes({ not_found: mode });
      const { strapi, attemptQuery, evidence } = createHarness({ tokenAgeMs: 2 * MINUTE });
      mockedAdapter.mockReturnValue({ status: jest.fn().mockResolvedValue(statusReply()) } as any);

      await processSnappayOperation(strapi, 88);

      expect(mockedCancel).not.toHaveBeenCalled();
      // The attempt stays parked for review exactly as it does today, which is
      // what lets the reservation sweep end it at the 30-minute TTL rather than
      // deferring its stock to the 1.5-hour ceiling.
      expect(attemptQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 11, Status: { $ne: "Succeeded" } },
          data: expect.objectContaining({ nextAction: "manual_review" }),
        }),
      );
      if (mode === "off") {
        // Byte-for-byte today: no decision pipeline at all.
        expect(evidence).toHaveLength(0);
      } else {
        expect(evidenceOf(evidence, "not_found_read")[0]).toMatchObject({
          decision: "observed",
          tokenAgeMs: expect.any(Number),
        });
      }
    }
  });

  it("schedules the confirming re-read without burning a ladder slot", async () => {
    setModes({ not_found: "shadow" });
    const { strapi, operationQuery } = createHarness({ tokenAgeMs: 2 * MINUTE });
    mockedAdapter.mockReturnValue({ status: jest.fn().mockResolvedValue(statusReply()) } as any);

    await processSnappayOperation(strapi, 88);

    const scheduled = operationQuery.update.mock.calls.find(
      ([call]: any[]) => call?.data?.metadata?.purpose === "confirm_not_found",
    );
    expect(scheduled).toBeDefined();
    // The attempt is parked but the *operation* stays queued. Using
    // `markManualReview` here would null `next_run_at` and the confirming read
    // would never happen — shadow would collect nothing.
    expect(scheduled![0].data.Status).toBe("Queued");
    expect(scheduled![0].data.nextRunAt).toBeInstanceOf(Date);
    expect(
      operationQuery.update.mock.calls.some(([call]: any[]) => call?.data?.nextRunAt === null),
    ).toBe(false);
    // retryCount is untouched: nothing failed, so nothing may consume one of
    // the five reconciliation slots.
    expect(scheduled![0].data).not.toHaveProperty("retryCount");
    // Salted job id, or BullMQ dedupes two schedules inside one minute bucket.
    expect(mockedEnqueue).toHaveBeenCalledWith(
      88,
      0,
      expect.any(Number),
      expect.objectContaining({ jobIdSalt: expect.stringContaining("confirm") }),
    );
  });

  it("lets the OK callback rescue the order instead of confirming a cancel", async () => {
    setModes({ not_found: "enforce" });
    const { strapi } = createHarness({
      tokenAgeMs: 45 * MINUTE,
      attempt: { providerStatus: "CALLBACK_OK", nextAction: "verify" },
      operation: { metadata: { callbackState: "OK" } },
      priorReads: [
        { observedAtMs: Date.now() - 40 * MINUTE, tokenAgeMs: 5 * MINUTE },
        { observedAtMs: Date.now() - 20 * MINUTE, tokenAgeMs: 25 * MINUTE },
      ],
    });
    const verify = jest.fn().mockResolvedValue({
      successful: true,
      response: { status: "VERIFY" },
      diagnostic: { endpoint: "verify", httpStatus: 200 },
    });
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(statusReply()),
      verify,
      settle: jest.fn().mockResolvedValue({
        successful: true,
        diagnostic: { endpoint: "settle", httpStatus: 200 },
      }),
    } as any);

    const result: any = await processSnappayOperation(strapi, 88);

    expect(result.action).toBe("VERIFY");
    expect(mockedCancel).not.toHaveBeenCalled();
  });
});

describe("confirmed NOT_FOUND", () => {
  const confirmedHarness = (extra: HarnessOptions = {}) =>
    createHarness({
      tokenAgeMs: 35 * MINUTE,
      priorReads: [
        { observedAtMs: Date.now() - 33 * MINUTE, tokenAgeMs: 2 * MINUTE },
        { observedAtMs: Date.now() - 20 * MINUTE, tokenAgeMs: 15 * MINUTE },
      ],
      ...extra,
    });

  it("records what it would have done, and changes nothing, in shadow", async () => {
    setModes({ not_found: "shadow" });
    const { strapi, evidence } = confirmedHarness();
    mockedAdapter.mockReturnValue({ status: jest.fn().mockResolvedValue(statusReply()) } as any);

    await processSnappayOperation(strapi, 88);

    expect(mockedCancel).not.toHaveBeenCalled();
    expect(evidenceOf(evidence, "not_found_confirmed")[0]).toMatchObject({
      decision: "would_release",
      mode: "shadow",
      walletAmountIrr: 3_000_000,
    });
  });

  it("releases through the one cancellation applier in enforce", async () => {
    process.env.SNAPPAY_AUTO_RELEASE_MAX_WALLET_IRR_PER_24H = "50000000";
    process.env.SNAPPAY_AUTO_RELEASE_MAX_SINGLE_WALLET_IRR = "9000000";
    setModes({ not_found: "enforce" });
    const { strapi } = confirmedHarness();
    mockedAdapter.mockReturnValue({ status: jest.fn().mockResolvedValue(statusReply()) } as any);

    await processSnappayOperation(strapi, 88);

    expect(mockedCancel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: 11, orderId: 22 }),
      "NOT_FOUND",
      "provider_not_found_confirmed",
      expect.objectContaining({
        walletReleaseReason: "provider_not_found_confirmed",
        // The row travels into the cancellation transaction, so it commits with
        // the release or not at all.
        evidence: expect.objectContaining({
          kind: "not_found_confirmed",
          decision: "released",
          mode: "enforce",
        }),
      }),
    );
  });

  it("refuses wallet-bearing releases while the value limits are unset", async () => {
    setModes({ not_found: "enforce" });
    const { strapi, evidence } = confirmedHarness();
    mockedAdapter.mockReturnValue({ status: jest.fn().mockResolvedValue(statusReply()) } as any);

    await processSnappayOperation(strapi, 88);

    expect(mockedCancel).not.toHaveBeenCalled();
    expect(evidenceOf(evidence, "not_found_confirmed")[0]).toMatchObject({
      decision: "refused_breaker_value",
    });
  });

  it("refuses a token it cannot prove belongs to this environment", async () => {
    setModes({ not_found: "enforce" });
    const { strapi, evidence, operationQuery } = confirmedHarness({
      generation: { providerHost: "snappay.production.invalid" },
    });
    mockedAdapter.mockReturnValue({ status: jest.fn().mockResolvedValue(statusReply()) } as any);

    await processSnappayOperation(strapi, 88);

    expect(mockedCancel).not.toHaveBeenCalled();
    expect(evidence.some((row) => row.decision === "refused_unproven")).toBe(true);
    // Parked, not re-read: another read would never make it provable.
    expect(
      operationQuery.update.mock.calls.some(([call]: any[]) => call?.data?.nextRunAt === null),
    ).toBe(true);
  });
});

describe("pulled runs", () => {
  it("re-queues an early confirming read without calling the provider", async () => {
    setModes({ not_found: "shadow" });
    const scheduledFor = new Date(Date.now() + 20 * MINUTE).toISOString();
    const { strapi } = createHarness({
      operation: {
        metadata: {
          purpose: "confirm_not_found",
          scheduledFor,
          pulledAt: new Date().toISOString(),
        },
      },
    });
    const status = jest.fn();
    mockedAdapter.mockReturnValue({ status } as any);

    const result: any = await processSnappayOperation(strapi, 88);

    expect(result.reason).toBe("pulled_before_scheduled_read");
    // A customer refreshing the result page must not manufacture the second
    // read that would release their own wallet.
    expect(status).not.toHaveBeenCalled();
  });

  it("runs immediately when the pull carries a callback", async () => {
    setModes({ not_found: "shadow" });
    const { strapi } = createHarness({
      operation: {
        metadata: {
          purpose: "confirm_not_found",
          scheduledFor: new Date(Date.now() + 20 * MINUTE).toISOString(),
          pulledAt: new Date().toISOString(),
          callbackState: "OK",
        },
      },
    });
    const status = jest.fn().mockResolvedValue(okStatus("PENDING"));
    mockedAdapter.mockReturnValue({
      status,
      verify: jest.fn().mockResolvedValue({
        successful: true,
        response: { status: "VERIFY" },
        diagnostic: { endpoint: "verify", httpStatus: 200 },
      }),
      settle: jest.fn().mockResolvedValue({
        successful: true,
        diagnostic: { endpoint: "settle", httpStatus: 200 },
      }),
    } as any);

    await processSnappayOperation(strapi, 88);

    // The branch that rescued 56 settled production orders must not wait out a
    // half-hour confirmation delay.
    expect(status).toHaveBeenCalled();
  });
});

describe("recovery reads on an attempt the sweep already ended", () => {
  it("observes without writing to the attempt", async () => {
    setModes({ not_found: "shadow" });
    const { strapi, attemptQuery, evidence } = createHarness({
      tokenAgeMs: 35 * MINUTE,
      attempt: { Status: "Expired" },
      order: { Status: "Cancelled" },
      operation: {
        metadata: { purpose: "confirm_not_found", scheduledFor: new Date(Date.now() - MINUTE).toISOString() },
      },
      priorReads: [
        { observedAtMs: Date.now() - 33 * MINUTE, tokenAgeMs: 2 * MINUTE },
        { observedAtMs: Date.now() - 20 * MINUTE, tokenAgeMs: 15 * MINUTE },
      ],
    });
    mockedAdapter.mockReturnValue({ status: jest.fn().mockResolvedValue(statusReply()) } as any);

    const result: any = await processSnappayOperation(strapi, 88);

    expect(result.observedOnly).toBe(true);
    // This is where most shadow data points land on production: the sweep ends
    // the attempt at ~+31 min, the confirming read is due at +30.
    expect(evidence[0]).toMatchObject({
      decision: "would_release",
      details: expect.objectContaining({ already_released_by: "sweep" }),
    });
    expect(attemptQuery.update).not.toHaveBeenCalled();
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it("routes a follow-up probe that finds a live payment to the matrix", async () => {
    setModes({ late_success: "shadow" });
    const { strapi, evidence } = createHarness({
      attempt: { Status: "Cancelled" },
      order: { Status: "Cancelled" },
      operation: {
        metadata: { purpose: "followup", shadow: true, scheduledFor: new Date(Date.now() - MINUTE).toISOString() },
      },
    });
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(okStatus("VERIFY")),
      revert: jest.fn(),
    } as any);

    await processSnappayOperation(strapi, 88);

    // A lingering VERIFY is auto-settled by SnappPay overnight, so shadow
    // records the reversal it would have made and parks it for an operator
    // rather than letting the deadline pass unnoticed.
    expect(evidenceOf(evidence, "late_success_observed")[0]).toMatchObject({
      decision: "would_revert",
      providerStatus: "VERIFY",
    });
    // The `followup` row is written *before* the matrix runs, and that
    // ordering is load-bearing: `listAttemptsAwaitingFollowup` skips an attempt
    // that already has one, so writing it afterwards (or not at all) would
    // re-probe the same stuck attempt every day forever.
    expect(evidenceOf(evidence, "followup")).toHaveLength(1);
    expect(evidence.findIndex((row) => row.kind === "followup")).toBeLessThan(
      evidence.findIndex((row) => row.kind === "late_success_observed"),
    );
  });

  it("records the probe before parking a settled contract for review", async () => {
    setModes({ late_success: "enforce" });
    const { strapi, evidence } = createHarness({
      attempt: { Status: "Cancelled" },
      order: { Status: "Cancelled" },
      operation: {
        metadata: {
          purpose: "followup",
          shadow: true,
          scheduledFor: new Date(Date.now() - MINUTE).toISOString(),
        },
      },
    });
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(okStatus("SETTLE")),
      revert: jest.fn(),
      cancel: jest.fn(),
    } as any);

    await processSnappayOperation(strapi, 88);

    // Same ordering guarantee for the state that stays parked longest.
    expect(evidenceOf(evidence, "followup")).toHaveLength(1);
    expect(evidenceOf(evidence, "late_success_review")[0]).toMatchObject({
      decision: "review",
      providerStatus: "SETTLE",
    });
  });
});

describe("late success on a locally cancelled attempt", () => {
  const lateHarness = (providerStatus: string, mode: RecoveryMode) => {
    setModes({ late_success: mode });
    const harness = createHarness({
      attempt: { Status: "Cancelled", providerStatus: "NOT_FOUND" },
      order: { Status: "Cancelled" },
      operation: { metadata: { locallyCancelled: true, callbackState: "OK" } },
    });
    const revert = jest.fn().mockResolvedValue({
      successful: true,
      diagnostic: { endpoint: "revert", httpStatus: 200 },
    });
    const settle = jest.fn();
    const verify = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(okStatus(providerStatus)),
      revert,
      settle,
      verify,
    } as any);
    return { ...harness, revert, settle, verify };
  };

  it("reverts PENDING and VERIFY in enforce, and never settles them", async () => {
    for (const providerStatus of ["PENDING", "VERIFY"]) {
      jest.clearAllMocks();
      const { strapi, revert, settle, verify, evidence } = lateHarness(providerStatus, "enforce");

      await processSnappayOperation(strapi, 88);

      expect(revert).toHaveBeenCalledWith(TOKEN);
      // `performRevert` would fall through a VERIFY to settle-then-cancel,
      // creating and voiding a real installment contract for a customer who is
      // not getting the goods. The late-success path must not do that.
      expect(settle).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(evidenceOf(evidence, "late_success_reverted")[0]).toMatchObject({
        decision: "reverted",
      });
    }
  });

  it("only records the decision in shadow", async () => {
    const { strapi, revert, evidence } = lateHarness("PENDING", "shadow");

    await processSnappayOperation(strapi, 88);

    expect(revert).not.toHaveBeenCalled();
    expect(evidenceOf(evidence, "late_success_observed")[0]).toMatchObject({
      decision: "would_revert",
    });
  });

  it("sends a settled installment contract to a human, never to an automatic cancel", async () => {
    const { strapi, revert, evidence } = lateHarness("SETTLE", "enforce");

    await processSnappayOperation(strapi, 88);

    expect(revert).not.toHaveBeenCalled();
    expect(evidenceOf(evidence, "late_success_review")[0]).toMatchObject({
      decision: "review",
      providerStatus: "SETTLE",
    });
  });

  it("never writes to the terminal attempt", async () => {
    const { strapi, attemptQuery } = lateHarness("SETTLE", "enforce");

    await processSnappayOperation(strapi, 88);

    expect(attemptQuery.update).not.toHaveBeenCalled();
  });
});

describe("aged REGISTERED tokens", () => {
  const registeredHarness = (mode: RecoveryMode, tokenAgeMs: number) => {
    setModes({ registered: mode });
    const harness = createHarness({
      tokenAgeMs,
      attempt: { providerStatus: "REGISTERED", WalletAmount: 0, GatewayAmount: 10_000_000 },
    });
    const revert = jest.fn().mockResolvedValue({
      successful: true,
      diagnostic: { endpoint: "revert", httpStatus: 200 },
    });
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(okStatus("REGISTERED")),
      revert,
    } as any);
    return { ...harness, revert };
  };

  it("leaves a young token alone", async () => {
    const { strapi, revert } = registeredHarness("enforce", 5 * MINUTE);

    await processSnappayOperation(strapi, 88);

    expect(revert).not.toHaveBeenCalled();
  });

  it("only records the decision in shadow", async () => {
    const { strapi, revert, evidence } = registeredHarness("shadow", 45 * MINUTE);

    await processSnappayOperation(strapi, 88);

    expect(revert).not.toHaveBeenCalled();
    expect(evidenceOf(evidence, "registered_aged")[0]).toMatchObject({
      decision: "would_revert",
    });
  });

  it("reverts an aged token in enforce and cancels locally", async () => {
    const { strapi, revert } = registeredHarness("enforce", 45 * MINUTE);

    await processSnappayOperation(strapi, 88);

    expect(revert).toHaveBeenCalledWith(TOKEN);
    expect(mockedCancel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: 11 }),
      // Names the decision as ours, not as something SnappPay reported.
      "REGISTERED_REVERTED",
      "registered_reverted",
      expect.objectContaining({
        walletReleaseReason: "registered_reverted",
        evidence: expect.objectContaining({ kind: "registered_reverted", decision: "reverted" }),
      }),
    );
  });

  it("waits SnappPay's 30 minutes when the revert answers 1011 registered", async () => {
    setModes({ registered: "enforce" });
    const { strapi, operationQuery } = createHarness({
      tokenAgeMs: 45 * MINUTE,
      attempt: { providerStatus: "REGISTERED", WalletAmount: 0, GatewayAmount: 10_000_000 },
    });
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(okStatus("REGISTERED")),
      revert: jest.fn().mockResolvedValue({
        successful: false,
        errorData: { errorCode: 1011, message: "not finalized", data: { status: "REGISTERED" } },
        diagnostic: {
          endpoint: "revert",
          httpStatus: 400,
          providerCode: 1011,
          transactionStatus: "REGISTERED",
        },
      }),
    } as any);

    await processSnappayOperation(strapi, 88);

    expect(mockedCancel).not.toHaveBeenCalled();
    const retry = operationQuery.update.mock.calls.find(
      ([call]: any[]) => call?.data?.Status === "Queued" && call?.data?.nextRunAt,
    );
    expect(retry).toBeDefined();
    const delayMs = new Date(retry![0].data.nextRunAt).getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(25 * MINUTE);
  });
});
