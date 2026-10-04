import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { ReturnGrantExchangeResponse } from "@repo/auth-core/contracts";
import {
  authServerOrigin,
  socialUrl,
  validatedSocialReturnPath,
} from "@/lib/central-auth-server";
import {
  applicationSessionMaxAge,
  setApplicationSessionCookie,
} from "@/lib/application-session";

const LOOP_COOKIE = "infinity_auth_restore_loop";

function failure(reason: string, attempt: number) {
  const url = socialUrl("/auth/complete");
  url.searchParams.set("error", reason);
  url.searchParams.set("attempt", String(attempt));
  const result = NextResponse.redirect(url, 307);
  result.headers.set("Cache-Control", "no-store, max-age=0");
  return result;
}

export async function GET(request: NextRequest) {
  const loop = Number(request.cookies.get(LOOP_COOKIE)?.value ?? "0");
  const attempt = Number.isSafeInteger(loop)
    ? Math.min(Math.max(loop, 0), 3)
    : 0;
  const grant = request.nextUrl.searchParams.get("grant") ?? "";
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(grant))
    return failure("invalid_grant", attempt);

  const controller = new AbortController();
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          Object.assign(new Error("Grant exchange deadline exceeded"), {
            name: "TimeoutError",
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
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ grant }),
        signal: controller.signal,
      }),
      interrupted,
    ]);
    if (!response.ok)
      return failure(
        response.status >= 500
          ? "grant_exchange_unavailable"
          : "grant_exchange_failed",
        attempt,
      );
    const payload = (await Promise.race([
      response.json(),
      interrupted,
    ])) as Partial<ReturnGrantExchangeResponse>;
    if (
      !response.ok ||
      payload.authenticated !== true ||
      typeof payload.applicationSession !== "string" ||
      !/^[A-Za-z0-9_-]{40,4096}$/.test(payload.applicationSession) ||
      typeof payload.applicationSessionExpiresAt !== "string"
    ) {
      return failure("grant_exchange_unavailable", attempt);
    }
    const returnPath = validatedSocialReturnPath(payload.returnTo);
    if (!returnPath) return failure("invalid_return", attempt);
    const sessionMaxAge = applicationSessionMaxAge(
      payload.applicationSessionExpiresAt,
    );
    if (!sessionMaxAge) return failure("expired_session", attempt);

    const complete = socialUrl("/auth/complete");
    complete.searchParams.set("returnTo", returnPath);

    complete.searchParams.set("attempt", String(attempt));
    const result = NextResponse.redirect(complete, 307);
    setApplicationSessionCookie(
      result,
      payload.applicationSession,
      sessionMaxAge,
    );
    // The callback only proves a one-time grant was valid. /auth/complete
    // issues the route hint after /auth/self confirms a usable session.
    result.headers.set("Cache-Control", "no-store, max-age=0");
    return result;
  } catch {
    return failure("grant_exchange_unavailable", attempt);
  } finally {
    clearTimeout(timeout);
  }
}
