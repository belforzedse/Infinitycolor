import { RedisClient } from "../../index";

const SMS_MARKER_TTL_SEC = 60 * 60 * 24 * 30;

export function buildSmsIdempotencyKey(parts: {
  type: string;
  orderId?: string | number | null;
  userId?: string | number | null;
  fingerprint?: string | number | null;
}): string {
  const type = String(parts.type || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const owner = parts.orderId ?? parts.userId ?? "global";
  const fingerprint = parts.fingerprint ?? "default";
  return `sms:order-notification:${type}:${owner}:${fingerprint}`
    .replace(/\s+/g, "_")
    .slice(0, 240);
}

export async function claimSmsIdempotency(key?: string | null, failOnError = false): Promise<boolean> {
  if (!key) return true;
  try {
    const client = await RedisClient;
    const result = await client.set(key, "1", { NX: true, EX: SMS_MARKER_TTL_SEC });
    return result === "OK";
  } catch (error) {
    if (failOnError) throw error;
    return false;
  }
}

export async function releaseSmsIdempotency(key?: string | null): Promise<void> {
  if (!key) return;
  try {
    const client = await RedisClient;
    await client.del(key);
  } catch {
    /* best-effort */
  }
}
