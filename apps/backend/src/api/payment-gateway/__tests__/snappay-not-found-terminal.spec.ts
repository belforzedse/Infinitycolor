/**
 * The 1007 decision table.
 *
 * The load-bearing fact behind every case here is production data: since the
 * merge-based observation writer landed (`56177efe`), 56 of 481 settled
 * attempts still carry `providerCode: 1007` next to a successful `settle`, and
 * they settled a median 4.3 minutes after the token was issued (p90 10.8, max
 * 23.4). A 1007 is "SnappPay has no record for this token right now", which
 * covers a shopper who quit *and* a shopper who has not yet reached the bank
 * step. Nothing in this file may conclude "unpaid" from one early read.
 */
import {
  decideSnappayRecovery,
  evaluateSnappayNotFound,
  type SnappayNotFoundFacts,
} from "../services/snappay-state-machine";

const MINUTE = 60 * 1000;

const facts = (overrides: Partial<SnappayNotFoundFacts> = {}): SnappayNotFoundFacts => ({
  provenanceOk: true,
  reads: [
    { observedAtMs: 1_000_000, tokenAgeMs: 2 * MINUTE },
    { observedAtMs: 1_000_000 + 30 * MINUTE, tokenAgeMs: 32 * MINUTE },
  ],
  tokenAgeMs: 32 * MINUTE,
  minTokenAgeMs: 30 * MINUTE,
  confirmDelayMs: 3 * MINUTE,
  resumedAtMs: null,
  hasOkCallback: false,
  ...overrides,
});

describe("evaluateSnappayNotFound", () => {
  it("confirms a proven, aged, twice-read token with no sign of life", () => {
    expect(evaluateSnappayNotFound(facts())).toEqual({
      confirmed: true,
      reason: "confirmed",
    });
  });

  it("never confirms a token we cannot prove is ours", () => {
    expect(evaluateSnappayNotFound(facts({ provenanceOk: false }))).toEqual({
      confirmed: false,
      reason: "unproven",
    });
  });

  it("never confirms below the minimum token age, however many reads there are", () => {
    const young = facts({
      tokenAgeMs: 12 * MINUTE,
      reads: [
        { observedAtMs: 1_000_000, tokenAgeMs: 2 * MINUTE },
        { observedAtMs: 1_000_000 + 5 * MINUTE, tokenAgeMs: 7 * MINUTE },
        { observedAtMs: 1_000_000 + 10 * MINUTE, tokenAgeMs: 12 * MINUTE },
      ],
    });
    // This is exactly the shape of the 56 production attempts that settled
    // after a 1007: three reads, all inside the first 23 minutes.
    expect(evaluateSnappayNotFound(young)).toEqual({
      confirmed: false,
      reason: "token_too_young",
    });
  });

  it("never confirms on a single read", () => {
    expect(
      evaluateSnappayNotFound(
        facts({ reads: [{ observedAtMs: 1_000_000, tokenAgeMs: 32 * MINUTE }] }),
      ),
    ).toEqual({ confirmed: false, reason: "too_few_reads" });
  });

  it("never confirms on two reads taken too close together", () => {
    expect(
      evaluateSnappayNotFound(
        facts({
          reads: [
            { observedAtMs: 1_000_000, tokenAgeMs: 31 * MINUTE },
            { observedAtMs: 1_000_000 + 30_000, tokenAgeMs: 31.5 * MINUTE },
          ],
        }),
      ),
    ).toEqual({ confirmed: false, reason: "reads_too_close" });
  });

  it("voids the sequence when the shopper reopened the stored payment page", () => {
    expect(
      evaluateSnappayNotFound(facts({ resumedAtMs: 1_000_000 + 10 * MINUTE })),
    ).toEqual({ confirmed: false, reason: "resumed_since_first_read" });

    // A resume that predates the first read is history, not a sign of life.
    expect(
      evaluateSnappayNotFound(facts({ resumedAtMs: 1_000_000 - 10 * MINUTE })).confirmed,
    ).toBe(true);
  });

  it("voids the sequence outright when the browser said the payment succeeded", () => {
    expect(evaluateSnappayNotFound(facts({ hasOkCallback: true }))).toEqual({
      confirmed: false,
      reason: "ok_callback",
    });
  });

  it("does not depend on the caller passing reads in order", () => {
    const reversed = facts({
      reads: [
        { observedAtMs: 1_000_000 + 30 * MINUTE, tokenAgeMs: 32 * MINUTE },
        { observedAtMs: 1_000_000, tokenAgeMs: 2 * MINUTE },
      ],
    });
    expect(evaluateSnappayNotFound(reversed).confirmed).toBe(true);
  });
});

describe("decideSnappayRecovery — 1007 under each mode", () => {
  const notFoundRead = { providerCode: 1007, providerStatus: undefined };

  it("parks for review exactly as today while the path is off", () => {
    expect(decideSnappayRecovery({ ...notFoundRead })).toBe("MANUAL_REVIEW");
    expect(
      decideSnappayRecovery({
        ...notFoundRead,
        notFoundMode: "off",
        notFound: { confirmed: true, reason: "confirmed" },
      }),
    ).toBe("MANUAL_REVIEW");
  });

  it("schedules a confirming read while the token is too young", () => {
    for (const mode of ["shadow", "enforce"] as const) {
      expect(
        decideSnappayRecovery({
          ...notFoundRead,
          notFoundMode: mode,
          notFound: { confirmed: false, reason: "token_too_young" },
        }),
      ).toBe("CONFIRM_NOT_FOUND");
    }
  });

  it("cancels locally only once the read is confirmed", () => {
    expect(
      decideSnappayRecovery({
        ...notFoundRead,
        notFoundMode: "enforce",
        notFound: { confirmed: true, reason: "confirmed" },
      }),
    ).toBe("CANCEL_LOCAL_NOT_FOUND");
  });

  it("sends an unprovable token to review rather than re-reading it forever", () => {
    expect(
      decideSnappayRecovery({
        ...notFoundRead,
        notFoundMode: "enforce",
        notFound: { confirmed: false, reason: "unproven" },
      }),
    ).toBe("MANUAL_REVIEW");
  });

  it("keeps the OK-callback rescue ahead of every NOT_FOUND branch", () => {
    // The branch that saved those 56 production orders.
    expect(
      decideSnappayRecovery({
        ...notFoundRead,
        callbackState: "OK",
        notFoundMode: "enforce",
        notFound: { confirmed: true, reason: "confirmed" },
      }),
    ).toBe("VERIFY");
  });

  it("keeps configuration and merchant-mismatch codes ahead of the modes", () => {
    expect(decideSnappayRecovery({ providerCode: 1051, notFoundMode: "enforce" })).toBe(
      "FAIL_CONFIGURATION",
    );
    expect(decideSnappayRecovery({ providerCode: 1048, notFoundMode: "enforce" })).toBe(
      "MANUAL_REVIEW",
    );
  });
});

describe("decideSnappayRecovery — aged REGISTERED", () => {
  it("keeps reconciling while the path is off, however old the token is", () => {
    expect(
      decideSnappayRecovery({ providerStatus: "REGISTERED", registeredAged: true }),
    ).toBe("RECONCILE");
  });

  it("keeps reconciling a young REGISTERED token even with the path on", () => {
    expect(
      decideSnappayRecovery({
        providerStatus: "REGISTERED",
        registeredAged: false,
        registeredMode: "enforce",
      }),
    ).toBe("RECONCILE");
  });

  it("reverts an aged REGISTERED token once the path is on", () => {
    for (const mode of ["shadow", "enforce"] as const) {
      expect(
        decideSnappayRecovery({
          providerStatus: "REGISTERED",
          registeredAged: true,
          registeredMode: mode,
        }),
      ).toBe("REVERT_REGISTERED_AGED");
    }
  });

  it("still prefers the explicit unpaid claims over the aged loop", () => {
    expect(
      decideSnappayRecovery({
        providerStatus: "REGISTERED",
        registeredAged: true,
        registeredMode: "enforce",
        callbackState: "FAILED",
      }),
    ).toBe("REVERT");
    expect(
      decideSnappayRecovery({
        providerStatus: "REGISTERED",
        registeredAged: true,
        registeredMode: "enforce",
        customerAbandoned: true,
      }),
    ).toBe("REVERT");
  });
});

describe("decideSnappayRecovery — late success on a locally cancelled attempt", () => {
  const cancelled = { locallyCancelled: true };

  it("never verifies, settles or finalizes", () => {
    const actions = (["PENDING", "VERIFY", "SETTLE", "REGISTERED", "UNKNOWN"] as const).map(
      (providerStatus) => decideSnappayRecovery({ ...cancelled, providerStatus }),
    );
    expect(actions).not.toContain("VERIFY");
    expect(actions).not.toContain("SETTLE");
    expect(actions).not.toContain("SETTLE_THEN_CANCEL");
    expect(actions).not.toContain("FINALIZE_LOCAL");
  });

  it("reverts the two states SnappPay documents a revert from", () => {
    expect(decideSnappayRecovery({ ...cancelled, providerStatus: "PENDING" })).toBe(
      "LATE_SUCCESS_REVERT",
    );
    expect(decideSnappayRecovery({ ...cancelled, providerStatus: "VERIFY" })).toBe(
      "LATE_SUCCESS_REVERT",
    );
  });

  it("routes a settled installment contract to a human, never to an automatic cancel", () => {
    expect(decideSnappayRecovery({ ...cancelled, providerStatus: "SETTLE" })).toBe(
      "LATE_SUCCESS_REVIEW",
    );
  });

  it("keeps probing REGISTERED and unreadable states", () => {
    expect(decideSnappayRecovery({ ...cancelled, providerStatus: "REGISTERED" })).toBe(
      "RECONCILE",
    );
    expect(decideSnappayRecovery({ ...cancelled, providerStatus: undefined })).toBe(
      "RECONCILE",
    );
  });

  it("just records an already-reversed or already-gone payment", () => {
    expect(decideSnappayRecovery({ ...cancelled, providerStatus: "REVERT" })).toBe("OBSERVE");
    expect(decideSnappayRecovery({ ...cancelled, providerStatus: "CANCEL" })).toBe("OBSERVE");
    expect(decideSnappayRecovery({ ...cancelled, providerCode: 1007 })).toBe("OBSERVE");
  });

  it("refuses to resurrect the order even when the browser returned OK", () => {
    // A late OK on a cancelled order is a payment to reverse, never an order to
    // un-cancel: the stock is gone and `verify` is the commit-to-fulfil call.
    expect(
      decideSnappayRecovery({ ...cancelled, callbackState: "OK", providerCode: 1007 }),
    ).toBe("OBSERVE");
    expect(
      decideSnappayRecovery({ ...cancelled, callbackState: "OK", providerStatus: "PENDING" }),
    ).toBe("LATE_SUCCESS_REVERT");
    expect(
      decideSnappayRecovery({ ...cancelled, callbackState: "OK", providerStatus: "UNKNOWN" }),
    ).toBe("RECONCILE");
  });
});

describe("decideSnappayRecovery — unchanged behaviour for open attempts", () => {
  it.each([
    ["SETTLE", undefined, "FINALIZE_LOCAL"],
    ["VERIFY", undefined, "SETTLE"],
    ["VERIFY", "FAILED", "SETTLE_THEN_CANCEL"],
    ["REVERT", undefined, "CANCEL_LOCAL"],
    ["CANCEL", undefined, "CANCEL_LOCAL"],
    ["PENDING", undefined, "VERIFY"],
    ["PENDING", "FAILED", "REVERT"],
    ["REGISTERED", undefined, "RECONCILE"],
    ["REGISTERED", "FAILED", "REVERT"],
    [undefined, "OK", "VERIFY"],
    [undefined, undefined, "RECONCILE"],
  ])("%s + callback %s -> %s", (providerStatus, callbackState, expected) => {
    expect(
      decideSnappayRecovery({
        providerStatus,
        callbackState: callbackState as any,
      }),
    ).toBe(expected);
  });

  it("never treats an unreadable provider as unpaid", () => {
    expect(
      decideSnappayRecovery({
        providerStatus: undefined,
        customerAbandoned: true,
        notFoundMode: "enforce",
        registeredMode: "enforce",
      }),
    ).toBe("RECONCILE");
  });
});
