import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isTrustedSocialRequest } from "@/lib/central-auth-server";
import {
  AUTH_ROUTE_HINT_COOKIE,
  AUTH_ROUTE_HINT_COOKIE_VALUE,
  AUTH_ROUTE_HINT_MAX_AGE_SECONDS,
} from "@/utils/authRouteHint";

const LOOP_COOKIE = "infinity_auth_restore_loop";

function trustedSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return isTrustedSocialRequest(origin, fetchSite);
}

function clearHint(response: NextResponse) {
  response.cookies.set(AUTH_ROUTE_HINT_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function DELETE(request: NextRequest) {
  if (!trustedSameOrigin(request))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const response = new NextResponse(null, { status: 204 });
  clearHint(response);
  return response;
}

/** Clears the hint and counts the attempt, so a restore loop cannot spin forever. */
export async function POST(request: NextRequest) {
  if (!trustedSameOrigin(request))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const current = Number(request.cookies.get(LOOP_COOKIE)?.value ?? "0");
  const next = Number.isSafeInteger(current) && current >= 0 ? Math.min(current + 1, 3) : 1;
  const response = new NextResponse(null, { status: 204 });
  clearHint(response);
  response.cookies.set(LOOP_COOKIE, String(next), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 60,
  });
  return response;
}

export async function PUT(request: NextRequest) {
  if (!trustedSameOrigin(request))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(AUTH_ROUTE_HINT_COOKIE, AUTH_ROUTE_HINT_COOKIE_VALUE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_ROUTE_HINT_MAX_AGE_SECONDS,
  });
  response.cookies.set(LOOP_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
