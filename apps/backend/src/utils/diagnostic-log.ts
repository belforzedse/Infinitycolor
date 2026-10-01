import * as Sentry from "@sentry/node";

const EVENTS = new Set([
  "diagnostics.probe",
  "payment.result:issue",
  "payment.result:failure",
  "payment.result:cancelled",
  "checkout.failure",
  "checkout.stock_changed_before_payment",
  "snappay.recovery.breaker_open",
  "snappay.not_found.shadow_decision",
  "snappay.not_found.auto_released",
  "snappay.registered.shadow_decision",
  "snappay.registered.reverted",
  "snappay.late_success.reverted",
]);
const KEYS = new Set([
  "area",
  "stage",
  "resultHint",
  "reasonCode",
  "gateway",
  "kind",
  "path",
  "breaker",
  "mode",
  "hasTransactionId",
  "itemCount",
  "removedCount",
  "adjustedCount",
  "mapped",
  "diagnostic_event",
  "sentry.release",
  "sentry.environment",
  "sentry.sdk.name",
  "sentry.sdk.version",
]);

export function diagnosticAttributes(
  attributes: Record<string, unknown> = {},
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!KEYS.has(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      safe[key] = value;
    else if (typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) safe[key] = value;
  }
  return safe;
}

export function beforeSendDiagnosticLog<
  T extends { message: unknown; attributes?: Record<string, unknown> },
>(log: T): T | null {
  if (typeof log.message !== "string" || !EVENTS.has(log.message)) return null;
  return { ...log, attributes: diagnosticAttributes(log.attributes) };
}

/** Logging is best effort and never takes ownership of an Issue by itself. */
export function logDiagnostic(
  event: string,
  attributes: Record<string, unknown> = {},
): boolean {
  try {
    if (typeof Sentry.isEnabled === "function" && !Sentry.isEnabled()) return false;
    if (!EVENTS.has(event) || typeof Sentry.logger?.info !== "function") return false;
    Sentry.logger.info(event, diagnosticAttributes({ ...attributes, diagnostic_event: event }));
    return true;
  } catch {
    return false;
  }
}

/** Returns true only after operations explicitly verified Logs ingestion. */
export function routeExpectedDiagnostic(
  event: string,
  attributes: Record<string, unknown> = {},
): boolean {
  return logDiagnostic(event, attributes) && process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS === "true";
}

export function reportExpectedDiagnostic(
  event: string,
  options: {
    level: "info" | "warning";
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
  },
): void {
  try {
    if (!routeExpectedDiagnostic(event, { ...options.tags, ...options.extra }))
      Sentry.captureMessage(event, options);
  } catch {
    /* Observability must never change a commerce decision. */
  }
}
