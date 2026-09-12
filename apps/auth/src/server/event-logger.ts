import { createHmac, randomUUID } from "node:crypto";

const ALLOWED_FIELDS = new Set([
  "event",
  "requestId",
  "reasonCode",
  "origin",
  "durationMs",
  "subjectTag",
  "status",
  "operation",
]);
const REQUEST_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function safeAuthRequestId(value: unknown): string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
    ? value
    : randomUUID();
}

export function keyedSubjectTag(value: string | number): string {
  const secret = process.env.AUTH_FLOW_SECRET?.trim();
  if (!secret || secret.length < 32 || /^replace-/i.test(secret)) {
    throw new Error(
      "AUTH_FLOW_SECRET must be configured before hashing auth event subjects",
    );
  }
  return createHmac("sha256", secret)
    .update(String(value), "utf8")
    .digest("base64url")
    .slice(0, 20);
}

export function authEvent(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  const record: Record<string, string | number | boolean> = {
    event,
    requestId: safeAuthRequestId(fields.requestId),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.has(key) && value !== undefined) record[key] = value;
  }
  console.info(JSON.stringify(record));
}
