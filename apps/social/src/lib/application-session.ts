import type { NextResponse } from "next/server";

export const APPLICATION_SESSION_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Host-infinitygram-session"
    : "infinitygram-session";

const MAX_SESSION_SECONDS = 7 * 24 * 60 * 60;

export function applicationSessionMaxAge(expiresAt: string): number | null {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return null;
  const remaining = Math.floor((expiresAtMs - Date.now()) / 1_000);
  if (remaining <= 0) return null;
  return Math.min(remaining, MAX_SESSION_SECONDS);
}

export function setApplicationSessionCookie(
  response: NextResponse,
  credential: string,
  maxAge: number,
): void {
  response.cookies.set(APPLICATION_SESSION_COOKIE, credential, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}

export function clearApplicationSessionCookie(response: NextResponse): void {
  response.cookies.set(APPLICATION_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
