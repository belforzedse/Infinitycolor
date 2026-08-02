import type { ConsoleMessage } from "@playwright/test";
import { centralAuthOrigin } from "./env";

const expectedHarnessTextMarkers = [
  "The Content Security Policy directive 'frame-ancestors' is ignored when delivered in a report-only policy.",
  "was delivered in report-only mode, but does not specify a 'report-to'; the policy will have no effect.",
  "Failed to preconnect to https://media.infinitycolor.test/. Error: Error resolving",
] as const;

const expectedUnresolvedHarnessHosts = new Set([
  "analytics.infinitycolor.co",
  "media.infinitycolor.test",
]);

function parsedLocation(message: ConsoleMessage): URL | null {
  const rawUrl = message.location().url;
  if (!rawUrl) return null;

  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * Ignores only failures deliberately produced by the isolated browser harness.
 * Runtime application errors, API failures, and unexpected external hosts stay
 * visible to the strict console assertions.
 */
export function isExpectedHarnessConsoleError(
  message: ConsoleMessage,
): boolean {
  if (message.type() !== "error") return false;

  const text = message.text();
  if (expectedHarnessTextMarkers.some((marker) => text.includes(marker))) {
    return true;
  }

  const location = parsedLocation(message);
  if (!location) return false;

  if (
    text.includes("401 (UNAUTHORIZED)") &&
    location.origin === centralAuthOrigin().replace(/\/$/, "") &&
    location.pathname === "/api/auth/token"
  ) {
    // A logged-out storefront probes for a host-only Better Auth session. The
    // native token endpoint answers 401 when none exists; that is expected and
    // the token manager converts it to a null session without logging an error.
    return true;
  }

  return (
    expectedUnresolvedHarnessHosts.has(location.hostname) &&
    (text.includes("ERR_NAME_NOT_RESOLVED") ||
      text.includes("Error resolving") ||
      text.includes("Name or service not known"))
  );
}
