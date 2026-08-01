import { NextRequest, NextResponse } from "next/server";
import type { ReturnGrantExchangeResponse } from "@repo/auth-core/contracts";
import { authServerOrigin, validatedStorefrontReturnPath } from "@/lib/central-auth-server";

const LOOP_COOKIE = "infinity_auth_restore_loop";

function failure(request: NextRequest, reason: string) {
  const url = new URL("/auth/complete", request.nextUrl.origin);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url, 307);
}

export async function GET(request: NextRequest) {
  const grant = request.nextUrl.searchParams.get("grant") ?? "";
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(grant)) return failure(request, "invalid_grant");

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
    if (!response.ok || payload.authenticated !== true)
      return failure(request, "grant_exchange_failed");
    const returnPath = validatedStorefrontReturnPath(payload.returnTo);
    if (!returnPath) return failure(request, "invalid_return");

    const complete = new URL("/auth/complete", request.nextUrl.origin);
    complete.searchParams.set("returnTo", returnPath);
    const loop = Number(request.cookies.get(LOOP_COOKIE)?.value ?? "0");
    complete.searchParams.set(
      "attempt",
      String(Number.isSafeInteger(loop) ? Math.min(Math.max(loop, 0), 3) : 0),
    );
    const result = NextResponse.redirect(complete, 307);
    // The callback proves only that a one-time grant was valid. The route hint
    // is issued later by /auth/complete, after /auth/self confirms that the
    // required first and last names are present.
    result.headers.set("Cache-Control", "no-store, max-age=0");
    return result;
  } catch {
    return failure(request, "grant_exchange_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
