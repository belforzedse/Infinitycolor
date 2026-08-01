import { createHmac, randomUUID } from "node:crypto";

const ALLOWED_FIELDS = new Set([
  "event",
  "requestId",
  "reasonCode",
  "origin",
  "durationMs",
  "subjectTag",
  "status",
]);

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
    requestId:
      typeof fields.requestId === "string" ? fields.requestId : randomUUID(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.has(key) && value !== undefined) record[key] = value;
  }
  console.info(JSON.stringify(record));
}
