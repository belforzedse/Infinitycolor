import { resolveReturnTarget, safeInternalPath } from "@repo/auth-core/redirects";
import { adminOrigin, exactHttpOrigin } from "@/config/admin-env";

export function adminUrl(path: string): URL {
  return new URL(path, adminOrigin());
}

export function isTrustedAdminRequest(origin: string | null, fetchSite: string | null): boolean {
  return (!origin || origin === adminOrigin()) && fetchSite !== "cross-site";
}

export function authServerOrigin(): string {
  const value = process.env.AUTH_SERVER_ORIGIN || process.env.NEXT_PUBLIC_AUTH_ORIGIN;
  if (!value) throw new Error("AUTH_SERVER_ORIGIN is required for central auth");
  return exactHttpOrigin("AUTH_SERVER_ORIGIN", value);
}

export function validatedAdminReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const origin = adminOrigin();
  const resolved = resolveReturnTarget(value, [origin], origin);
  const url = new URL(resolved);
  if (url.origin !== origin) return null;
  return safeInternalPath(`${url.pathname}${url.search}${url.hash}`);
}
