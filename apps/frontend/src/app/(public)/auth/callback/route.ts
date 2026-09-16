import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import type { ReturnGrantExchangeResponse } from "@repo/auth-core/contracts";
import {
  authServerOrigin,
  storefrontUrl,
  validatedStorefrontReturnPath,
} from "@/lib/central-auth-server";
import { browserFamily } from "@/lib/browser-family";

const LOOP_COOKIE = "infinity_auth_restore_loop";

function reportCallbackFailure(request: NextRequest, reason: string, attempt: number) {
  try {
    Sentry.captureMessage(`auth.callback:${reason}`, {
      // A shopper bounced here has effectively failed to log in, and repeats mean
      // the restore loop is running rather than a one-off bad grant.
      level: attempt > 0 ? "error" : "warning",
      tags: {
        area: "auth",
        step: "storefront_callback",
        reasonCode: reason,
        browser: browserFamily(request.headers.get("user-agent")),
      },
      extra: {
        loopAttempt: attempt,
        hasSessionCookie: request.cookies
          .getAll()
          .some((cookie) => cookie.name.includes("infinity-auth")),
        // Names only — never values. Tells us whether the browser is storing the
        // auth cookies at all, which is what a redirect loop usually comes down to.
        cookieNames: request.cookies.getAll().map((cookie) => cookie.name),
      },
    });
  } catch {
    // Never let telemetry break the redirect.
  }
}

function loopAttempt(request: NextRequest): number {
  const raw = Number(request.cookies.get(LOOP_COOKIE)?.value ?? "0");
  return Number.isSafeInteger(raw) ? Math.min(Math.max(raw, 0), 3) : 0;
}

function failure(reason: string) {
  const url = storefrontUrl("/auth/complete");
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url, 307);
}

export async function GET(request: NextRequest) {
  const attempt = loopAttempt(request);
  const grant = request.nextUrl.searchParams.get("grant") ?? "";
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(grant)) {
    reportCallbackFailure(request, "invalid_grant", attempt);
    return failure("invalid_grant");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${authServerOrigin()}/api/auth/infinity/return-grant/exchange`, {
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ grant }),
      signal: controller.signal,
    });
    const payload = (await response
      .json()
      .catch(() => ({}))) as Partial<ReturnGrantExchangeResponse>;
    if (!response.ok || payload.authenticated !== true) {
      reportCallbackFailure(request, "grant_exchange_failed", attempt);
      return failure("grant_exchange_failed");
    }
    const returnPath = validatedStorefrontReturnPath(payload.returnTo);
    if (!returnPath) {
      reportCallbackFailure(request, "invalid_return", attempt);
      return failure("invalid_return");
    }

    // The grant was valid, so a non-zero attempt means the shopper already came
    // through here and was sent back anyway — the loop customers are reporting.
    if (attempt > 0) reportCallbackFailure(request, "restore_loop", attempt);

    const complete = storefrontUrl("/auth/complete");
    complete.searchParams.set("returnTo", returnPath);
    complete.searchParams.set("attempt", String(attempt));
    const result = NextResponse.redirect(complete, 307);
    // The callback proves only that a one-time grant was valid. The route hint
    // is issued later by /auth/complete, after /auth/self confirms that the
    // required first and last names are present.
    result.headers.set("Cache-Control", "no-store, max-age=0");
    return result;
  } catch (error) {
    reportCallbackFailure(request, "grant_exchange_unavailable", attempt);
    Sentry.captureException(error, {
      tags: { area: "auth", step: "storefront_callback", reasonCode: "grant_exchange_unavailable" },
    });
    return failure("grant_exchange_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
