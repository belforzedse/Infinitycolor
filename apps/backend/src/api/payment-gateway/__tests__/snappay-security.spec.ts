import {
  generateSnappayCallbackNonce,
  generateSnappayTransactionId,
  hashSnappayCallbackNonce,
  isValidSnappayCallbackNonce,
  isValidSnappayTransactionId,
  matchesSnappayCallbackNonce,
  snappayTokenFingerprint,
} from "../services/snappay-security";
import {
  decideSnappayRecovery,
  normalizeSnappayProviderStatus,
  SNAPPAY_RECONCILIATION_DELAYS_MS,
} from "../services/snappay-state-machine";
import {
  assertSnappayRuntimeConfig,
  getSnappayReturnUrl,
  isSnappayReconciliationExhausted,
} from "../services/snappay-orchestrator";

describe("SnappPay security primitives", () => {
  it("fingerprints a token stably and without key material", () => {
    // Keyless on purpose: the previous implementation HMAC'd with the encryption
    // key, so the fingerprint changed whenever the key rotated.
    const first = snappayTokenFingerprint("provider-token");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(snappayTokenFingerprint("provider-token")).toBe(first);
    expect(snappayTokenFingerprint("other-token")).not.toBe(first);
    expect(() => snappayTokenFingerprint("")).toThrow("SNAPPAY_SECRET_EMPTY");
  });

  it("generates provider-compatible stable identifiers and callback nonces", () => {
    const transactionId = generateSnappayTransactionId();
    const nonce = generateSnappayCallbackNonce();
    expect(transactionId).toHaveLength(10);
    expect(isValidSnappayTransactionId(transactionId)).toBe(true);
    expect(isValidSnappayCallbackNonce(nonce)).toBe(true);
    expect(matchesSnappayCallbackNonce(nonce, hashSnappayCallbackNonce(nonce))).toBe(true);
    expect(
      matchesSnappayCallbackNonce(generateSnappayCallbackNonce(), hashSnappayCallbackNonce(nonce)),
    ).toBe(false);
  });
});

describe("SnappPay recovery policy", () => {
  it("moves unresolved reconciliation to manual review after the finite schedule", () => {
    expect(isSnappayReconciliationExhausted(SNAPPAY_RECONCILIATION_DELAYS_MS.length - 1)).toBe(
      false,
    );
    expect(isSnappayReconciliationExhausted(SNAPPAY_RECONCILIATION_DELAYS_MS.length)).toBe(true);
  });

  it.each([
    ["SETTLE", "OK", "FINALIZE_LOCAL"],
    ["VERIFY", "OK", "SETTLE"],
    ["VERIFY", "FAILED", "SETTLE_THEN_CANCEL"],
    ["PENDING", "OK", "VERIFY"],
    ["PENDING", "FAILED", "REVERT"],
    ["REVERT", "OK", "CANCEL_LOCAL"],
    ["CANCEL", "FAILED", "CANCEL_LOCAL"],
  ] as const)("%s with %s selects %s", (providerStatus, callbackState, action) => {
    expect(decideSnappayRecovery({ providerStatus, callbackState })).toBe(action);
  });

  it("routes unknown, venture mismatch, and invalid-token outcomes safely", () => {
    expect(normalizeSnappayProviderStatus("garbage")).toBe("UNKNOWN");
    expect(decideSnappayRecovery({ providerStatus: "garbage" })).toBe("RECONCILE");
    expect(decideSnappayRecovery({ providerCode: 1048 })).toBe("MANUAL_REVIEW");
    expect(decideSnappayRecovery({ providerCode: 1007 })).toBe("MANUAL_REVIEW");
    expect(decideSnappayRecovery({ providerCode: 1051 })).toBe("FAIL_CONFIGURATION");
  });

  it("keeps reconciling when the provider code came from a failed status read", () => {
    // Production ran with a `status` endpoint that returned 404/1007 on every
    // call. Treating that as definitive parked the attempt and the expiry sweep
    // then cancelled the order and released its stock — on payments we had no
    // way to observe. An unobserved code describes the lookup, not the payment.
    expect(decideSnappayRecovery({ providerCode: 1007, statusObserved: false })).toBe(
      "RECONCILE",
    );
    expect(decideSnappayRecovery({ providerCode: 1048, statusObserved: false })).toBe(
      "RECONCILE",
    );
    // A configuration failure is about our own request, so it stays definitive.
    expect(decideSnappayRecovery({ providerCode: 1051, statusObserved: false })).toBe(
      "FAIL_CONFIGURATION",
    );
  });

  it("verifies a validated OK callback instead of waiting on an unreadable status", () => {
    // /status cannot resolve a token before verify() has been called on it at
    // least once, so a callback-confirmed payment would otherwise loop in
    // RECONCILE forever and eventually get auto-cancelled by the expiry sweep.
    expect(
      decideSnappayRecovery({
        providerStatus: undefined,
        providerCode: 1007,
        statusObserved: false,
        callbackState: "OK",
      }),
    ).toBe("VERIFY");

    // Without a validated OK callback, an unreadable status still just reconciles.
    expect(
      decideSnappayRecovery({
        providerStatus: undefined,
        providerCode: 1007,
        statusObserved: false,
      }),
    ).toBe("RECONCILE");

    // A FAILED callback has its own path (PENDING+FAILED -> REVERT); an unreadable
    // status alongside it must not be reinterpreted as a reason to verify.
    expect(
      decideSnappayRecovery({
        providerStatus: undefined,
        providerCode: 1007,
        statusObserved: false,
        callbackState: "FAILED",
      }),
    ).toBe("RECONCILE");
  });

  describe("abandoned REGISTERED tokens", () => {
    const abandonAfterMs = 30 * 60 * 1000;

    it("keeps reconciling while the customer could still be paying", () => {
      expect(
        decideSnappayRecovery({
          providerStatus: "REGISTERED",
          attemptAgeMs: 5 * 60 * 1000,
          abandonAfterMs,
        }),
      ).toBe("RECONCILE");
    });

    it("reverts an unpaid token once the checkout is abandoned", () => {
      // No money was ever taken for a REGISTERED token, so there is nothing for a
      // human to adjudicate — reverting releases the stock without manual review.
      expect(
        decideSnappayRecovery({
          providerStatus: "REGISTERED",
          attemptAgeMs: 31 * 60 * 1000,
          abandonAfterMs,
        }),
      ).toBe("REVERT");
    });

    it("still reconciles an unreadable provider state regardless of age", () => {
      // UNKNOWN means we could not observe the provider. Age must never turn that
      // into an auto-cancel.
      expect(
        decideSnappayRecovery({
          providerStatus: "garbage",
          attemptAgeMs: 10 * 24 * 60 * 60 * 1000,
          abandonAfterMs,
        }),
      ).toBe("RECONCILE");
    });

    it("does not treat a missing age as abandoned", () => {
      expect(
        decideSnappayRecovery({
          providerStatus: "REGISTERED",
          attemptAgeMs: null,
          abandonAfterMs,
        }),
      ).toBe("RECONCILE");
    });
  });
});

describe("SnappPay runtime configuration", () => {
  const configKeys = [
    "SNAPPAY_BASE_URL",
    "SNAPPAY_CLIENT_ID",
    "SNAPPAY_CLIENT_SECRET",
    "SNAPPAY_USERNAME",
    "SNAPPAY_PASSWORD",
    "SNAPPAY_RETURN_URL",
  ] as const;
  const originalConfig = Object.fromEntries(configKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    process.env.SNAPPAY_BASE_URL = "https://provider.test.invalid";
    process.env.SNAPPAY_CLIENT_ID = "client";
    process.env.SNAPPAY_CLIENT_SECRET = "secret";
    process.env.SNAPPAY_USERNAME = "username";
    process.env.SNAPPAY_PASSWORD = "password";
    process.env.SNAPPAY_RETURN_URL = "https://storefront.test.invalid/api/snapp/return";
  });

  afterAll(() => {
    for (const key of configKeys) {
      const original = originalConfig[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("validates the provider and callback HTTPS URLs during startup", () => {
    expect(() => assertSnappayRuntimeConfig()).not.toThrow();

    process.env.SNAPPAY_BASE_URL = "http://provider.test.invalid";
    expect(() => assertSnappayRuntimeConfig()).toThrow(
      "SNAPPAY_CONFIG_INVALID:SNAPPAY_BASE_URL must use HTTPS",
    );

    process.env.SNAPPAY_BASE_URL = "https://provider.test.invalid";
    process.env.SNAPPAY_RETURN_URL = "http://storefront.test.invalid/api/snapp/return";
    expect(() => assertSnappayRuntimeConfig()).toThrow(
      "SNAPPAY_CONFIG_INVALID:SNAPPAY_RETURN_URL must use HTTPS",
    );
  });

  it("supports the registered shared API callback URL and appends correlation", () => {
    process.env.SNAPPAY_RETURN_URL = "https://api.infinitycolor.co/api/orders/payment-callback";

    expect(getSnappayReturnUrl("abcdefghijklmnopqrstuv")).toBe(
      "https://api.infinitycolor.co/api/orders/payment-callback?nonce=abcdefghijklmnopqrstuv",
    );
  });
});
