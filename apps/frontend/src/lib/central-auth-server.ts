import { resolveReturnTarget, safeInternalPath } from "@repo/auth-core/redirects";
import { SITE_URL } from "@/config/site";

function exactOrigin(name: string, value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  return url.origin;
}

export function storefrontOrigin(): string {
  // SITE_URL is hardcoded for production builds; see config/site.ts.
  return exactOrigin("SITE_URL", SITE_URL);
}

export function storefrontUrl(path: string): URL {
  return new URL(path, storefrontOrigin());
}

export function isTrustedStorefrontRequest(
  origin: string | null,
  fetchSite: string | null,
): boolean {
  return (!origin || origin === storefrontOrigin()) && fetchSite !== "cross-site";
}

export function authServerOrigin(): string {
  const value = process.env.AUTH_SERVER_ORIGIN || process.env.NEXT_PUBLIC_AUTH_ORIGIN;
  if (!value) throw new Error("AUTH_SERVER_ORIGIN is required for central auth");
  return exactOrigin("AUTH_SERVER_ORIGIN", value);
}

export function validatedStorefrontReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const origin = storefrontOrigin();
  const resolved = resolveReturnTarget(value, [origin], origin);
  const url = new URL(resolved);
  if (url.origin !== origin) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return safeInternalPath(path);
}
