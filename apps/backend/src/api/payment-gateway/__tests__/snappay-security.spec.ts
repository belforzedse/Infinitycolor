import {
  decryptSnappaySecret,
  encryptSnappaySecret,
  generateSnappayCallbackNonce,
  generateSnappayTransactionId,
  getSnappayDecryptionMaterial,
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
  isSnappayReconciliationExhausted,
} from "../services/snappay-orchestrator";

const material = {
  key: Buffer.alloc(32, 7),
  version: "test-v1",
};

describe("SnappPay security primitives", () => {
  it("encrypts authenticated provider tokens without storing plaintext", () => {
    const encrypted = encryptSnappaySecret("provider-token", material);
    expect(encrypted).not.toContain("provider-token");
    expect(decryptSnappaySecret(encrypted, material)).toBe("provider-token");
    expect(snappayTokenFingerprint("provider-token", material)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects ciphertext tampering", () => {
    const encrypted = encryptSnappaySecret("provider-token", material);
    const ciphertextStart = encrypted.lastIndexOf(".") + 1;
    const replacement = encrypted[ciphertextStart] === "A" ? "B" : "A";
    const tampered = `${encrypted.slice(0, ciphertextStart)}${replacement}${encrypted.slice(
      ciphertextStart + 1,
    )}`;

    expect(tampered).not.toBe(encrypted);
    expect(() => decryptSnappaySecret(tampered, material)).toThrow("SNAPPAY_SECRET_INVALID");
  });

  it("retains explicit old keys for in-flight token decryption during rotation", () => {
    const oldMaterial = {
      key: Buffer.alloc(32, 3),
      version: "old-v1",
    };
    const encrypted = encryptSnappaySecret("in-flight-token", oldMaterial);
    const selected = getSnappayDecryptionMaterial("old-v1", {
      PAYMENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      PAYMENT_TOKEN_ENCRYPTION_KEY_VERSION: "current-v2",
      PAYMENT_TOKEN_DECRYPTION_KEYS: JSON.stringify({
        "old-v1": oldMaterial.key.toString("base64"),
      }),
    });

    expect(decryptSnappaySecret(encrypted, selected)).toBe("in-flight-token");
  });

  it("fails closed when an encrypted token key version is unavailable", () => {
    expect(() =>
      getSnappayDecryptionMaterial("missing-v0", {
        PAYMENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
        PAYMENT_TOKEN_ENCRYPTION_KEY_VERSION: "current-v2",
      }),
    ).toThrow("SNAPPAY_SECRET_KEY_VERSION_UNKNOWN");
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
});

describe("SnappPay runtime configuration", () => {
  const configKeys = [
    "SNAPPAY_BASE_URL",
    "SNAPPAY_CLIENT_ID",
    "SNAPPAY_CLIENT_SECRET",
    "SNAPPAY_USERNAME",
    "SNAPPAY_PASSWORD",
    "SNAPPAY_RETURN_URL",
    "PAYMENT_TOKEN_ENCRYPTION_KEY",
    "PAYMENT_TOKEN_ENCRYPTION_KEY_VERSION",
  ] as const;
  const originalConfig = Object.fromEntries(configKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    process.env.SNAPPAY_BASE_URL = "https://provider.test.invalid";
    process.env.SNAPPAY_CLIENT_ID = "client";
    process.env.SNAPPAY_CLIENT_SECRET = "secret";
    process.env.SNAPPAY_USERNAME = "username";
    process.env.SNAPPAY_PASSWORD = "password";
    process.env.SNAPPAY_RETURN_URL = "https://storefront.test.invalid/api/snapp/return";
    process.env.PAYMENT_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.PAYMENT_TOKEN_ENCRYPTION_KEY_VERSION = "test-v1";
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
});
