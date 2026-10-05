import * as Sentry from "@sentry/nextjs";
import { logDiagnostic } from "./diagnostic-log";
import { TRANSIENT_NETWORK_MESSAGES } from "./storefront-sentry-tags";

export const RECOVERY_WINDOW_MS = 30_000;
let lastRetryAt = -Infinity;
let pending:
  | { error: Error; surface: string; digest?: string; startedAt: number; pathname: string }
  | undefined;
const reported = new WeakMap<Error, number>();
let lastReport: { key: string; at: number } | undefined;

export function isTransientStorefrontError(error?: Error): boolean {
  return Boolean(
    error &&
      (error.name === "NetworkError" ||
        TRANSIENT_NETWORK_MESSAGES.has(error.message.replace(/^(?:TypeError|Error):\s*/, ""))),
  );
}

export function canRetryStorefrontError(error?: Error): boolean {
  return isTransientStorefrontError(error) && Date.now() - lastRetryAt >= RECOVERY_WINDOW_MS;
}

export function retryStorefrontError(
  error: Error & { digest?: string },
  surface: string,
  retry: () => void,
): boolean {
  if (!isTransientStorefrontError(error) || Date.now() - lastRetryAt < RECOVERY_WINDOW_MS)
    return false;
  lastRetryAt = Date.now();
  pending = {
    error,
    surface,
    digest: error.digest,
    startedAt: lastRetryAt,
    pathname: typeof window === "undefined" ? "" : window.location.pathname,
  };
  logDiagnostic("storefront.recovery", {
    recovery_surface: surface,
    recovery_outcome: "retry_dispatched",
    next_error_digest: error.digest,
  });
  try {
    retry();
  } catch {
    reportStorefrontError(error, surface);
  }
  return true;
}

/** Called only by a newly committed, successful route subtree. */
export function completeStorefrontRecovery(surface?: string): void {
  if (!pending || (surface && pending.surface !== surface)) return;
  if (typeof window !== "undefined" && pending.pathname !== window.location.pathname) {
    pending = undefined;
    return;
  }
  if (Date.now() - pending.startedAt <= RECOVERY_WINDOW_MS) {
    logDiagnostic("storefront.recovery", {
      recovery_surface: pending.surface,
      recovery_outcome: "recovered",
      next_error_digest: pending.digest,
    });
  }
  pending = undefined;
}

export function reportStorefrontError(error: Error & { digest?: string }, surface: string): void {
  const key = `${error.digest ? "digest" : surface}:${error.digest || error.name}:${error.message}`;
  const now = Date.now();
  if (
    now - (reported.get(error) ?? -Infinity) < RECOVERY_WINDOW_MS ||
    (lastReport?.key === key && now - lastReport.at < RECOVERY_WINDOW_MS)
  )
    return;
  reported.set(error, now);
  lastReport = { key, at: now };
  pending = undefined;
  try {
    Sentry.captureException(error, {
      tags: {
        recovery_surface: surface,
        recovery_outcome: isTransientStorefrontError(error) ? "exhausted" : "failed",
        ...(error.digest ? { next_error_digest: error.digest } : {}),
      },
    });
  } catch {
    /* The recovery UI must remain available. */
  }
}

/** A successful commit/navigation clears pending; stale boundary timers then do nothing. */
export function exhaustStorefrontRecovery(
  error: Error & { digest?: string },
  surface: string,
): boolean {
  if (!pending || pending.error !== error || pending.surface !== surface) return false;
  if (typeof window !== "undefined" && pending.pathname !== window.location.pathname) {
    pending = undefined;
    return false;
  }
  reportStorefrontError(error, surface);
  return true;
}

/** Explicit route navigation cancels the old recovery; unknown AbortErrors still report. */
export function cancelStorefrontRecovery(): void {
  if (pending)
    logDiagnostic("storefront.recovery", {
      recovery_surface: pending.surface,
      recovery_outcome: "cancelled",
    });
  pending = undefined;
}
