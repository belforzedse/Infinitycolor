import { NextResponse, type NextRequest } from "next/server";
import { isTrustedAdminRequest } from "@/lib/central-auth-server";
import {
  AUTH_ROUTE_HINT_COOKIE,
  AUTH_ROUTE_HINT_COOKIE_VALUE,
  AUTH_ROUTE_HINT_MAX_AGE_SECONDS,
} from "@/utils/authRouteHint";

const LOOP_COOKIE = "infinity_admin_auth_restore_loop";
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

function trusted(request: NextRequest): boolean {
  return isTrustedAdminRequest(
    request.headers.get("origin"),
    request.headers.get("sec-fetch-site"),
  );
}

function forbidden() {
  return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
}

function clearHint(response: NextResponse) {
  response.cookies.set(AUTH_ROUTE_HINT_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  response.headers.set("Cache-Control", "no-store, max-age=0");
}

export async function DELETE(request: NextRequest) {
  if (!trusted(request)) return forbidden();
  const response = new NextResponse(null, { status: 204 });
  clearHint(response);
  return response;
}

export async function POST(request: NextRequest) {
  if (!trusted(request)) return forbidden();
  const current = Number(request.cookies.get(LOOP_COOKIE)?.value ?? "0");
  const next = Number.isSafeInteger(current) && current >= 0 ? Math.min(current + 1, 3) : 1;
  const response = new NextResponse(null, { status: 204 });
  clearHint(response);
  response.cookies.set(LOOP_COOKIE, String(next), { ...COOKIE_OPTIONS, maxAge: 5 * 60 });
  return response;
}

export async function PUT(request: NextRequest) {
  if (!trusted(request)) return forbidden();
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(AUTH_ROUTE_HINT_COOKIE, AUTH_ROUTE_HINT_COOKIE_VALUE, {
    ...COOKIE_OPTIONS,
    maxAge: AUTH_ROUTE_HINT_MAX_AGE_SECONDS,
  });
  response.cookies.set(LOOP_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
