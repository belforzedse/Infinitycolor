import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { BetterAuthTokenResponse } from "@repo/auth-core/contracts";
import {
  APPLICATION_SESSION_COOKIE,
  clearApplicationSessionCookie,
} from "@/lib/application-session";
import {
  authServerOrigin,
  isTrustedSocialRequest,
  socialOrigin,
} from "@/lib/central-auth-server";

function noStoreJson(body: unknown, status: number): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function GET(request: NextRequest) {
  if (
    !isTrustedSocialRequest(
      request.headers.get("origin"),
      request.headers.get("sec-fetch-site"),
    )
  ) {
    return noStoreJson({ message: "Forbidden" }, 403);
  }

  const credential = request.cookies.get(APPLICATION_SESSION_COOKIE)?.value;
  if (!credential) return noStoreJson({ message: "Unauthorized" }, 401);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const upstream = await fetch(
      `${authServerOrigin()}/api/auth/infinity/application-token`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ credential, audience: socialOrigin() }),
        signal: controller.signal,
      },
    );
    const payload = (await upstream.json().catch(() => ({}))) as Partial<
      BetterAuthTokenResponse & { message: string }
    >;
    if (
      !upstream.ok ||
      typeof payload.token !== "string" ||
      payload.token.split(".").length !== 3
    ) {
      const status = upstream.status >= 500 ? 502 : 401;
      const response = noStoreJson(
        { message: status === 401 ? "Unauthorized" : "Authentication unavailable" },
        status,
      );
      if (status === 401) clearApplicationSessionCookie(response);
      return response;
    }
    return noStoreJson({ token: payload.token }, 200);
  } catch {
    return noStoreJson({ message: "Authentication unavailable" }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
