export const EXPECTED_CHECKOUT_SENTRY_CODES = [
  "PAYMENT_IN_PROGRESS",
  "PAYMENT_UNKNOWN",
  "CHECKOUT_ATTEMPT_CONFLICT",
  "SNAPPAY_RECONCILIATION_PENDING",
  "SNAPPAY_MANUAL_REVIEW",
  "SNAPPAY_TOKEN_DUPLICATE",
  "ORDER_CANCELLED",
  "RESERVATION_EXPIRED",
  "CART_EMPTY",
  "REVERT",
] as const;

export type ExpectedCheckoutSentryCode = (typeof EXPECTED_CHECKOUT_SENTRY_CODES)[number];

const EXPECTED_CHECKOUT_SENTRY_CODE_SET: ReadonlySet<string> = new Set(
  EXPECTED_CHECKOUT_SENTRY_CODES,
);

export const EXPECTED_CHECKOUT_SENTRY_IGNORE = new RegExp(
  `^checkout\\.error:(?:${EXPECTED_CHECKOUT_SENTRY_CODES.join("|")})$`,
);

export function isExpectedCheckoutSentryCode(code: string | undefined): boolean {
  return Boolean(code && EXPECTED_CHECKOUT_SENTRY_CODE_SET.has(code));
}

export function checkoutDiagnosticDisposition(
  code: string,
  response?: { details?: { reason?: string }; telemetryOwner?: string },
): "log" | "expected" | "issue" {
  if (response?.telemetryOwner === "backend") return "log";
  if (
    isExpectedCheckoutSentryCode(code) ||
    code === "STOCK_CHANGED" ||
    (code === "STOCK_RESERVATION_FAILED" && response?.details?.reason === "insufficient_stock")
  )
    return "expected";
  return "issue";
}

export function isExpectedCheckoutSentryMessage(message: string | undefined): boolean {
  return Boolean(message && EXPECTED_CHECKOUT_SENTRY_IGNORE.test(message));
}

type SentryEventLike = {
  message?: string;
  tags?: Record<string, unknown>;
  exception?: {
    values?: Array<{ value?: string }>;
  };
};

/**
 * Only an owning operation can establish an expected outcome. A matching title alone is insufficient.
 */
export function dropExpectedCheckoutSentryEvent<T extends SentryEventLike>(event: T): T | null {
  const message = event.message || event.exception?.values?.[0]?.value;
  if (
    isExpectedCheckoutSentryMessage(message) &&
    event.tags?.operation === "checkout" &&
    event.tags?.reporting_classification === "expected"
  ) {
    return null;
  }
  return event;
}
