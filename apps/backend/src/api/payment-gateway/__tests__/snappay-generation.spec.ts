import {
  buildSnappayPendingDispatch,
  isConsecutiveSnappayGeneration,
  nextSnappayGenerationSeq,
  snappayDispatchWasAttempted,
  snappayHasInFlightDispatch,
  snappayProviderGenerationIsTerminal,
  snappayProviderPaymentIsUnresolved,
  statusMatchesActiveSnappayGeneration,
  withIssuedSnappayToken,
  withSnappayPendingDispatch,
  withSnappayTerminalEvidence,
} from "../services/snappay-generation";

describe("SnappPay generation identity", () => {
  it("authorizes only the immediate next generation", () => {
    expect(nextSnappayGenerationSeq(0)).toBe(1);
    expect(nextSnappayGenerationSeq(1)).toBe(2);
    expect(isConsecutiveSnappayGeneration(1, 2)).toBe(true);
    expect(isConsecutiveSnappayGeneration(1, 3)).toBe(false);
  });

  it("treats a persisted candidate without a token as in-flight, not replaceable", () => {
    const pending = buildSnappayPendingDispatch({
      seq: 1,
      transactionId: "ABC1234567",
      callbackNonceHash: "hash",
    });
    const providerResponse = withSnappayPendingDispatch({}, pending);
    expect(snappayHasInFlightDispatch(providerResponse)).toBe(true);
    expect(
      snappayProviderPaymentIsUnresolved({ Status: "Pending", providerResponse }, ""),
    ).toBe(true);
    expect(snappayDispatchWasAttempted({ providerResponse }, "")).toBe(true);
  });

  it("does not treat a pre-token providerReference as a dispatched generation", () => {
    expect(
      snappayDispatchWasAttempted({ providerReference: "ABC1234567", providerResponse: {} }, ""),
    ).toBe(false);
    expect(
      snappayProviderPaymentIsUnresolved(
        { Status: "Created", providerReference: "ABC1234567", providerResponse: {} },
        "",
      ),
    ).toBe(false);
  });

  it("keeps a local Cancelled attempt unresolved until the provider generation is terminal", () => {
    const issued = withIssuedSnappayToken(
      {},
      {
        seq: 1,
        transactionId: "ABC1234567",
        callbackNonceHash: "hash",
        paymentTokenFingerprint: "fp",
        paymentToken: "token",
      },
    );
    expect(
      snappayProviderPaymentIsUnresolved(
        { Status: "Cancelled", providerStatus: "PENDING", providerResponse: issued },
        "token",
      ),
    ).toBe(true);
    const terminal = withSnappayTerminalEvidence(issued, "REVERT");
    expect(
      snappayProviderGenerationIsTerminal({
        providerStatus: "UNKNOWN",
        providerResponse: terminal,
      }),
    ).toBe(true);
    expect(
      snappayProviderPaymentIsUnresolved(
        { Status: "Cancelled", providerStatus: "REVERT", providerResponse: terminal },
        "token",
      ),
    ).toBe(false);
  });

  it("rejects a status payload bound to another transaction or amount", () => {
    const issued = withIssuedSnappayToken(
      {},
      {
        seq: 1,
        transactionId: "ABC1234567",
        callbackNonceHash: "hash",
        paymentTokenFingerprint: "fp",
        paymentToken: "token",
      },
    );
    const attempt = {
      Amount: 2_200_000,
      providerReference: "ABC1234567",
      providerResponse: issued,
    };
    expect(
      statusMatchesActiveSnappayGeneration(attempt, {
        transactionId: "ZZZZZZZZZZ",
        amount: 2_200_000,
      }),
    ).toEqual({ ok: false, reason: "transaction" });
    expect(
      statusMatchesActiveSnappayGeneration(attempt, {
        transactionId: "ABC1234567",
        amount: 99,
      }),
    ).toEqual({ ok: false, reason: "amount" });
    expect(
      statusMatchesActiveSnappayGeneration(attempt, {
        transactionId: "ABC1234567",
        amount: 2_200_000,
      }),
    ).toEqual({ ok: true });
  });
});
