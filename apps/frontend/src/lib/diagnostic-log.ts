import * as Sentry from "@sentry/nextjs";

const EVENTS = new Set([
  "diagnostics.probe",
  "checkout.failure",
  "storefront.recovery",
  "video.recovery",
  "video.autoplay_denied",
  "story.autoplay_denied",
]);
const KEYS = new Set([
  "area",
  "stage",
  "reasonCode",
  "gateway",
  "hasDiscountCode",
  "recovery_surface",
  "recovery_outcome",
  "next_error_digest",
  "video_surface",
  "video_engine",
  "video_failure",
  "media_type",
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

export function logDiagnostic(event: string, attributes: Record<string, unknown> = {}): boolean {
  try {
    if (typeof Sentry.isEnabled === "function" && !Sentry.isEnabled()) return false;
    if (!EVENTS.has(event) || typeof Sentry.logger?.info !== "function") return false;
    Sentry.logger.info(event, diagnosticAttributes({ ...attributes, diagnostic_event: event }));
    return true;
  } catch {
    return false;
  }
}

export function routeExpectedDiagnostic(
  event: string,
  attributes: Record<string, unknown> = {},
): boolean {
  return (
    logDiagnostic(event, attributes) &&
    process.env.NEXT_PUBLIC_SENTRY_EXPECTED_EVENTS_TO_LOGS === "true"
  );
}
