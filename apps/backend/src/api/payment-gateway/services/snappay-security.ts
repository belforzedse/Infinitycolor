import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const TRANSACTION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const TRANSACTION_FIRST_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type SnappayEncryptionMaterial = {
  key: Buffer;
  version: string;
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] || "").trim();
  if (!value) {
    throw new Error(`SNAPPAY_CONFIG_INVALID:${name} is required`);
  }
  return value;
}

export function getSnappayEncryptionMaterial(
  env: NodeJS.ProcessEnv = process.env,
): SnappayEncryptionMaterial {
  const encoded = requiredEnv(env, "PAYMENT_TOKEN_ENCRYPTION_KEY");
  const version = requiredEnv(env, "PAYMENT_TOKEN_ENCRYPTION_KEY_VERSION");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error(
      "SNAPPAY_CONFIG_INVALID:PAYMENT_TOKEN_ENCRYPTION_KEY must decode to 32 bytes",
    );
  }
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(version)) {
    throw new Error(
      "SNAPPAY_CONFIG_INVALID:PAYMENT_TOKEN_ENCRYPTION_KEY_VERSION is invalid",
    );
  }
  return { key, version };
}

export function getSnappayDecryptionMaterial(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): SnappayEncryptionMaterial {
  const current = getSnappayEncryptionMaterial(env);
  if (version === current.version) return current;

  const serialized = String(
    env.PAYMENT_TOKEN_DECRYPTION_KEYS || "",
  ).trim();
  if (!serialized) {
    throw new Error("SNAPPAY_SECRET_KEY_VERSION_UNKNOWN");
  }

  let keyring: unknown;
  try {
    keyring = JSON.parse(serialized);
  } catch {
    throw new Error(
      "SNAPPAY_CONFIG_INVALID:PAYMENT_TOKEN_DECRYPTION_KEYS must be valid JSON",
    );
  }
  if (
    !keyring ||
    Array.isArray(keyring) ||
    typeof keyring !== "object"
  ) {
    throw new Error(
      "SNAPPAY_CONFIG_INVALID:PAYMENT_TOKEN_DECRYPTION_KEYS must be a version-to-base64 object",
    );
  }

  const encoded = String(
    (keyring as Record<string, unknown>)[version] || "",
  ).trim();
  const key = Buffer.from(encoded, "base64");
  if (
    !/^[A-Za-z0-9._-]{1,32}$/.test(version) ||
    key.length !== 32
  ) {
    throw new Error("SNAPPAY_SECRET_KEY_VERSION_UNKNOWN");
  }
  return { key, version };
}

export function encryptSnappaySecret(
  plaintext: string,
  material: SnappayEncryptionMaterial = getSnappayEncryptionMaterial(),
): string {
  if (!plaintext) {
    throw new Error("SNAPPAY_SECRET_EMPTY");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, material.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    material.version,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSnappaySecret(
  encrypted: string,
  material?: SnappayEncryptionMaterial,
): string {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded, extra] =
    String(encrypted || "").split(".");
  if (
    extra !== undefined ||
    !version ||
    !ivEncoded ||
    !tagEncoded ||
    !ciphertextEncoded
  ) {
    throw new Error("SNAPPAY_SECRET_INVALID");
  }
  const resolvedMaterial =
    material || getSnappayDecryptionMaterial(version);
  if (version !== resolvedMaterial.version) {
    throw new Error("SNAPPAY_SECRET_INVALID");
  }
  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      resolvedMaterial.key,
      Buffer.from(ivEncoded, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("SNAPPAY_SECRET_INVALID");
  }
}

export function snappayTokenFingerprint(
  token: string,
  material: SnappayEncryptionMaterial = getSnappayEncryptionMaterial(),
): string {
  if (!token) throw new Error("SNAPPAY_SECRET_EMPTY");
  return createHmac("sha256", material.key).update(token).digest("hex");
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
