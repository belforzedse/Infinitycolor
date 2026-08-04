type LogLevel = "info" | "warn" | "error";

const FORBIDDEN_FIELD = /authorization|cookie|token|secret|password|phone|email|national|customer|order/i;

export function adminLog(
  level: LogLevel,
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => !FORBIDDEN_FIELD.test(key) && value !== undefined),
  );
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "infinity-admin",
    environment: process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT || "development",
    release: process.env.RELEASE_SHA || process.env.NEXT_PUBLIC_RELEASE_SHA || "development",
    event,
    ...safeFields,
  });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.info(record);
}
