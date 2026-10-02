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
import { redactCatalogCause } from "@/lib/catalog-error-diagnostics";

const LOOP_COOKIE = "infinity_auth_restore_loop";

function reportCallbackFailure(
  request: NextRequest,
  reason: string,
  attempt: number,
  cause?: unknown,
  status?: number,
) {
  try {
    const error = new Error(`auth.callback:${reason}`);
    error.name = "AuthCallbackError";
    if (cause) error.cause = redactCatalogCause(cause, "request");
    Sentry.captureException(error, {
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
        httpStatus: status,
        operation: "grant_exchange",
        outcome: reason === "grant_exchange_unavailable" ? "ambiguous" : "rejected",
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
  const result = NextResponse.redirect(url, 307);
  result.headers.set("Cache-Control", "no-store, max-age=0");
  return result;
}

export async function GET(request: NextRequest) {
  const attempt = loopAttempt(request);
  const grant = request.nextUrl.searchParams.get("grant") ?? "";
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(grant)) {
    reportCallbackFailure(request, "invalid_grant", attempt);
    return failure("invalid_grant");
  }

  const controller = new AbortController();
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          Object.assign(new Error("Grant exchange deadline exceeded"), {
            name: "TimeoutError",
            code: "ETIMEDOUT",
          }),
        ),
      { once: true },
    );
  });
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await Promise.race([
      fetch(`${authServerOrigin()}/api/auth/infinity/return-grant/exchange`, {
        method: "POST",
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ grant }),
        signal: controller.signal,
      }),
      interrupted,
    ]);
    if (!response.ok) {
      const reason =
        response.status >= 500 ? "grant_exchange_unavailable" : "grant_exchange_failed";
      reportCallbackFailure(request, reason, attempt, undefined, response.status);
      return failure(reason);
    }
    const payload = (await Promise.race([
      response.json(),
      interrupted,
    ])) as Partial<ReturnGrantExchangeResponse>;
    if (payload?.authenticated !== true) {
      reportCallbackFailure(
        request,
        "grant_exchange_unavailable",
        attempt,
        new SyntaxError("Invalid exchange response"),
        response.status,
      );
      return failure("grant_exchange_unavailable");
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
    reportCallbackFailure(request, "grant_exchange_unavailable", attempt, error);
    return failure("grant_exchange_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
