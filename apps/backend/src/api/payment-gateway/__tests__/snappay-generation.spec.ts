import {
  buildSnappayPendingDispatch,
  isConsecutiveSnappayGeneration,
  nextSnappayGenerationSeq,
  snappayDispatchWasAttempted,
  snappayFingerprintsAlign,
  snappayHasInFlightDispatch,
  snappayObservationPatch,
  snappayProviderGenerationIsTerminal,
  snappayProviderPaymentIsUnresolved,
  snappayStoredPaymentPageResume,
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

  it("aligns full SHA-256 fingerprints with their display prefixes", () => {
    const full = "abcdef0123456789ffff";
    expect(snappayFingerprintsAlign(full, full.slice(0, 12))).toBe(true);
    expect(snappayFingerprintsAlign("aaaaaaaaaaaa", "bbbbbbbbbbbb")).toBe(false);
    expect(snappayFingerprintsAlign("", "abcd")).toBe(true);
  });

  it("strips generation identity keys from observation patches", () => {
    const patch = snappayObservationPatch(
      { successful: false, diagnostic: { endpoint: "status", httpStatus: 404, providerCode: 1007 } },
      {
        generation: { seq: 9 },
        tokenAttemptSeq: 9,
        pendingDispatch: { seq: 9 },
        observedAt: "keep",
      },
    );
    expect(patch).toEqual(
      expect.objectContaining({
        endpoint: "status",
        httpStatus: 404,
        providerCode: 1007,
        observedAt: "keep",
      }),
    );
    expect(patch).not.toHaveProperty("generation");
    expect(patch).not.toHaveProperty("tokenAttemptSeq");
    expect(patch).not.toHaveProperty("pendingDispatch");
  });

  it("resumes a stored payment page only for eligible current-generation identity", () => {
    const token = "provider-payment-token";
    const issued = withIssuedSnappayToken(
      {},
      {
        seq: 1,
        transactionId: "ABC1234567",
        callbackNonceHash: "hash",
        paymentTokenFingerprint: "fpfpfpfpfpfp",
        paymentToken: token,
      },
    );
    const eligible = {
      paymentToken: token,
      urlToken: token,
      storedTrackId: token,
      redirectUrl: `https://pay.snapp.test/start?paymentToken=${token}`,
      orderStatus: "Paying",
      reservationStatus: "Reserved",
      attemptStatus: "Redirected",
      attemptAmount: 2_200_000,
      contractAmountToman: 220_000,
      quoteTotalToman: 220_000,
      providerReference: "ABC1234567",
      providerResponse: issued,
      tokenFingerprint: "fpfpfpfpfpfp",
      hasValidatedCallback: false,
    };
    expect(snappayStoredPaymentPageResume(eligible)).toEqual({ ok: true });
    expect(
      snappayStoredPaymentPageResume({ ...eligible, hasValidatedCallback: true }),
    ).toEqual({ ok: false, reason: "callback-recovery" });
    expect(
      snappayStoredPaymentPageResume({
        ...eligible,
        urlToken: "other-token",
        redirectUrl: "https://pay.snapp.test/start?paymentToken=other-token",
      }),
    ).toEqual({ ok: false, reason: "token-url-mismatch" });
    expect(
      snappayStoredPaymentPageResume({
        ...eligible,
        providerResponse: {
          ...issued,
          previousGeneration: {
            seq: 1,
            transactionId: "OLDOLDOLD1",
            dispatchedAt: new Date().toISOString(),
            paymentToken: token,
          },
          generation: {
            ...(issued.generation as object),
            seq: 2,
            transactionId: "NEWNEWNEW1",
            paymentToken: "replacement-token",
          },
          tokenAttemptSeq: 2,
        },
        providerReference: "NEWNEWNEW1",
      }),
    ).toEqual({ ok: false, reason: "previous-generation" });
  });

  it("allows a metadata-wiped legacy row only when TrackId still matches the stored URL", () => {
    const token = "provider-payment-token";
    const wiped = {
      paymentToken: token,
      urlToken: token,
      storedTrackId: token,
      redirectUrl: `https://pay.snapp.test/start?paymentToken=${token}`,
      orderStatus: "Paying",
      reservationStatus: "Reserved",
      attemptStatus: "Unknown",
      attemptAmount: 2_200_000,
      contractAmountToman: 220_000,
      quoteTotalToman: 220_000,
      providerReference: "ABC1234567",
      providerResponse: { requestId: "ABC1234567", refId: "ABC1234567" },
      hasValidatedCallback: false,
    };
    expect(snappayStoredPaymentPageResume(wiped)).toEqual({ ok: true });
    expect(
      snappayStoredPaymentPageResume({ ...wiped, storedTrackId: "" }),
    ).toEqual({ ok: false, reason: "identity-unproven" });
    expect(
      snappayStoredPaymentPageResume({
        ...wiped,
        urlToken: "other-token",
        redirectUrl: "https://pay.snapp.test/start?paymentToken=other-token",
      }),
    ).toEqual({ ok: false, reason: "token-url-mismatch" });
  });
});
