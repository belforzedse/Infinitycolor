import * as Sentry from "@sentry/nextjs";

/**
 * Sentry reporting for the login journey.
 *
 * `sentry.server.config.ts` deliberately strips cookies, headers, body and query
 * string from every event, because an auth event must never carry a phone number,
 * OTP code, password or session token. Nothing here reintroduces those: the fields
 * below are codes, booleans and durations, plus a coarse browser family derived
 * from the User-Agent rather than the User-Agent itself.
 */

export type AuthStep =
  | "entry"
  | "phone_status"
  | "otp_start"
  | "otp_verify"
  | "password_verify"
  | "password_reset"
  | "register_info"
  | "profile"
  | "session_exchange"
  | "return_grant"
  | "flow_state";

export type AuthDiagnosticLevel = "info" | "warning" | "error";

export interface AuthDiagnostic {
  step: AuthStep;
  reasonCode: string;
  level?: AuthDiagnosticLevel;
  requestId?: string;
  /** Request headers, read only for the coarse browser family. Never forwarded. */
  headers?: Headers | null;
  status?: number;
  durationMs?: number;
  /** Why the sealed flow cookie was refused, when this is a flow-state failure. */
  flowRejection?: string | null;
  /** True when the flow cookie carries the `__Host-` prefix some browsers reject. */
  hostPrefixedCookie?: boolean;
  /** How many times the storefront has already bounced this visitor back. */
  loopAttempt?: number;
  error?: unknown;
}

const BROWSER_MATCHERS: ReadonlyArray<readonly [RegExp, string]> = [
  // Samsung Internet must precede Chrome: its UA contains both tokens.
  [/SamsungBrowser\/(\d+)/i, "samsung-internet"],
  [/\bFBAN|\bFBAV|Instagram/i, "meta-webview"],
  [/\bEdgA?\/(\d+)/i, "edge"],
  [/OPR\/(\d+)|Opera/i, "opera"],
  [/\bFirefox\/(\d+)/i, "firefox"],
  [/CriOS\/(\d+)/i, "chrome-ios"],
  [/\bChrome\/(\d+)/i, "chrome"],
  [/Version\/(\d+).*Safari/i, "safari"],
];

/**
 * A coarse family plus major version (e.g. `samsung-internet-21`). The storefront
 * rules forbid emitting raw UA strings, and a family is what a browser-specific
 * bug actually needs.
 */
export function browserFamily(userAgent: string | null | undefined): string {
  if (!userAgent) return "unknown";
  for (const [pattern, name] of BROWSER_MATCHERS) {
    const match = pattern.exec(userAgent);
    if (match) return match[1] ? `${name}-${match[1]}` : name;
  }
  return "other";
}

function headerBrowser(headers: Headers | null | undefined): string {
  try {
    return browserFamily(headers?.get("user-agent"));
  } catch {
    return "unknown";
  }
}

/**
 * Report one step of the login journey. Expected outcomes (a mistyped OTP, a
 * cooldown) go in at `info` so they stay searchable without paging anyone;
 * anything unexpected goes in at `error`.
 */
export function reportAuthDiagnostic(input: AuthDiagnostic): void {
  const {
    step,
    reasonCode,
    level = "error",
    requestId,
    headers,
    status,
    durationMs,
    flowRejection,
    hostPrefixedCookie,
    loopAttempt,
    error,
  } = input;

  try {
    const scope: Parameters<typeof Sentry.captureMessage>[1] = {
      level,
      tags: {
        area: "auth",
        step,
        reasonCode,
        browser: headerBrowser(headers),
        ...(flowRejection ? { flowRejection } : {}),
        ...(status !== undefined ? { status: String(status) } : {}),
      },
      extra: {
        ...(requestId ? { requestId } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(hostPrefixedCookie !== undefined ? { hostPrefixedCookie } : {}),
        ...(loopAttempt !== undefined ? { loopAttempt } : {}),
      },
    };

    if (error !== undefined) {
      Sentry.captureException(error, scope);
      return;
    }
    Sentry.captureMessage(`auth.${step}:${reasonCode}`, scope);
  } catch {
    // Telemetry must never turn a recoverable auth failure into a 500.
  }
}
