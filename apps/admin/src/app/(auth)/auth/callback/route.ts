import { NextResponse, type NextRequest } from "next/server";
import type { ReturnGrantExchangeResponse } from "@repo/auth-core/contracts";
import { adminUrl, authServerOrigin, validatedAdminReturnPath } from "@/lib/central-auth-server";

const LOOP_COOKIE = "infinity_admin_auth_restore_loop";

function failure(reason: string) {
  const url = adminUrl("/auth/complete");
  url.searchParams.set("error", reason);
  const response = NextResponse.redirect(url, 307);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function GET(request: NextRequest) {
  const grant = request.nextUrl.searchParams.get("grant") ?? "";
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(grant)) return failure("invalid_grant");
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
    const payload = (await response.json().catch(() => ({}))) as Partial<ReturnGrantExchangeResponse>;
    if (!response.ok || payload.authenticated !== true) return failure("grant_exchange_failed");
    const returnPath = validatedAdminReturnPath(payload.returnTo);
    if (!returnPath) return failure("invalid_return");
    const complete = adminUrl("/auth/complete");
    complete.searchParams.set("returnTo", returnPath);
    const loop = Number(request.cookies.get(LOOP_COOKIE)?.value ?? "0");
    complete.searchParams.set("attempt", String(Number.isSafeInteger(loop) ? Math.min(Math.max(loop, 0), 3) : 0));
    const result = NextResponse.redirect(complete, 307);
    result.headers.set("Cache-Control", "no-store, max-age=0");
    return result;
  } catch {
    return failure("grant_exchange_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
