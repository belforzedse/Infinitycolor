import { NextResponse } from "next/server";
import { storefrontUrl } from "@/lib/central-auth-server";
import { AUTH_ROUTE_HINT_COOKIE } from "@/utils/authRouteHint";

export function GET() {
  const target = storefrontUrl("/auth/logout-complete");
  const response = NextResponse.redirect(target, 307);
  for (const name of [AUTH_ROUTE_HINT_COOKIE, "infinity_auth_restore_loop"]) {
    response.cookies.set(name, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
