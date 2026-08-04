import { NextResponse } from "next/server";
import { adminUrl } from "@/lib/central-auth-server";
import { AUTH_ROUTE_HINT_COOKIE } from "@/utils/authRouteHint";

export function GET() {
  const response = NextResponse.redirect(adminUrl("/auth/logout-complete"), 307);
  for (const name of [AUTH_ROUTE_HINT_COOKIE, "infinity_admin_auth_restore_loop"]) {
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
