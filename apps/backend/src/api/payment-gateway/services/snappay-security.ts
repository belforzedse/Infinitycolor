import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const TRANSACTION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const TRANSACTION_FIRST_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Stable, non-reversible short label for a SnappPay payment token, safe to put in
 * logs and operator UI. Plain SHA-256 with no key material, so it does not change
 * across deploys and needs no configuration.
 */
export function snappayTokenFingerprint(token: string): string {
  if (!token) throw new Error("SNAPPAY_SECRET_EMPTY");
  return createHash("sha256").update(token).digest("hex");
}

export function displaySnappayFingerprint(fingerprint: string): string {
  const normalized = String(fingerprint || "");
  return normalized ? normalized.slice(0, 12) : "";
}

export function generateSnappayCallbackNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function hashSnappayCallbackNonce(nonce: string): string {
  return createHash("sha256").update(String(nonce || "")).digest("hex");
}

export function matchesSnappayCallbackNonce(
  nonce: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashSnappayCallbackNonce(nonce), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return (
    actual.length > 0 &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

export function generateSnappayTransactionId(): string {
  const first = TRANSACTION_FIRST_ALPHABET[
    randomBytes(1)[0] % TRANSACTION_FIRST_ALPHABET.length
  ];
  const bytes = randomBytes(9);
  let rest = "";
  for (const byte of bytes) {
    rest += TRANSACTION_ALPHABET[byte % TRANSACTION_ALPHABET.length];
  }
  return `${first}${rest}`;
}

export function normalizeIranMobile(value: unknown): string {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) return `+98${digits.slice(1)}`;
  if (/^989\d{9}$/.test(digits)) return `+${digits}`;
  if (/^9\d{9}$/.test(digits)) return `+98${digits}`;
  return "";
}

export function isValidSnappayTransactionId(value: unknown): boolean {
  return /^(?=.*[A-Za-z])[A-Za-z0-9]{5,10}$/.test(
    String(value || "").trim(),
  );
}

export function isValidSnappayCallbackNonce(value: unknown): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(String(value || "").trim());
}
