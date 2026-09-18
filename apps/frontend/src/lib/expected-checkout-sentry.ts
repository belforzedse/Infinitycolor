export const EXPECTED_CHECKOUT_SENTRY_CODES = [
  "PAYMENT_IN_PROGRESS",
  "PAYMENT_UNKNOWN",
  "CHECKOUT_ATTEMPT_CONFLICT",
  "SNAPPAY_RECONCILIATION_PENDING",
  "SNAPPAY_MANUAL_REVIEW",
  "SNAPPAY_TOKEN_DUPLICATE",
  "ORDER_CANCELLED",
  "RESERVATION_EXPIRED",
  "RESERVATION_LOOKUP_FAILED",
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

export function isExpectedCheckoutSentryMessage(message: string | undefined): boolean {
  return Boolean(message && EXPECTED_CHECKOUT_SENTRY_IGNORE.test(message));
}

type SentryEventLike = {
  message?: string;
  exception?: {
    values?: Array<{ value?: string }>;
  };
};

/**
 * Client `beforeSend` drop for expected checkout states. Lives next to the
 * ignoreErrors regex so a stale checkout chunk cannot keep the same titles at
 * error level after a cutover.
 */
export function dropExpectedCheckoutSentryEvent<T extends SentryEventLike>(event: T): T | null {
  const message = event.message || event.exception?.values?.[0]?.value;
  if (isExpectedCheckoutSentryMessage(message)) {
    return null;
  }
  return event;
}
