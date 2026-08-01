import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const BRIDGE_TIMESTAMP_HEADER = "x-infinity-auth-timestamp";
export const BRIDGE_NONCE_HEADER = "x-infinity-auth-nonce";
export const BRIDGE_SIGNATURE_HEADER = "x-infinity-auth-signature";
export const BRIDGE_BODY_DIGEST_HEADER = "x-infinity-auth-body-sha256";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value ?? {}));
}

export function sha256Body(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("base64url");
}

export interface BridgeSignatureInput {
  secret: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  bodyDigest: string;
}

export function bridgeCanonicalRequest(
  input: Omit<BridgeSignatureInput, "secret">,
): string {
  return [
    "infinity-auth-bridge-v1",
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    input.bodyDigest,
  ].join("\n");
}

export function createBridgeSignature(input: BridgeSignatureInput): string {
  return createHmac("sha256", input.secret)
    .update(bridgeCanonicalRequest(input), "utf8")
    .digest("base64url");
}

export function verifyBridgeSignature(
  input: BridgeSignatureInput & { signature: string },
): boolean {
  const expected = Buffer.from(createBridgeSignature(input), "utf8");
  const received = Buffer.from(input.signature, "utf8");
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

export function createBridgeNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function createBridgeHeaders(
  secret: string,
  method: string,
  path: string,
  body: unknown,
  now = Date.now(),
): { body: string; headers: Record<string, string> } {
  const serializedBody = canonicalJson(body);
  const timestamp = Math.floor(now / 1_000).toString(10);
  const nonce = createBridgeNonce();
  const bodyDigest = sha256Body(serializedBody);
  const signature = createBridgeSignature({
    secret,
    timestamp,
    nonce,
    method,
    path,
    bodyDigest,
  });

  return {
    body: serializedBody,
    headers: {
      "content-type": "application/json",
      [BRIDGE_TIMESTAMP_HEADER]: timestamp,
      [BRIDGE_NONCE_HEADER]: nonce,
      [BRIDGE_BODY_DIGEST_HEADER]: bodyDigest,
      [BRIDGE_SIGNATURE_HEADER]: signature,
    },
  };
}
