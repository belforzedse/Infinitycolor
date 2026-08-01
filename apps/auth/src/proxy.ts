import { NextResponse, type NextRequest } from "next/server";

function contentSecurityPolicy(nonce: string): string {
  const developmentScript =
    process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const upgrade =
    process.env.NODE_ENV === "production" ? "; upgrade-insecure-requests" : "";
  return (
    [
      "default-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "object-src 'none'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentScript}`,
      "connect-src 'self'",
    ].join("; ") + upgrade
  );
}

function withCsp(response: NextResponse, policy: string): NextResponse {
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

function trustedOrigins(): Set<string> {
  const configured = (process.env.AUTH_TRUSTED_STOREFRONT_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  const authOrigin = process.env.BETTER_AUTH_URL
    ? new URL(process.env.BETTER_AUTH_URL).origin
    : null;
  if (authOrigin) configured.push(authOrigin);
  return new Set(configured);
}

function withCors(response: NextResponse, origin: string | null): NextResponse {
  response.headers.append("Vary", "Origin");
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const policy = contentSecurityPolicy(nonce);
  const origin = request.headers.get("origin");
  const allowed = trustedOrigins();
  if (origin && !allowed.has(origin)) {
    return withCsp(
      withCors(
        NextResponse.json({ message: "Origin not allowed" }, { status: 403 }),
        null,
      ),
      policy,
    );
  }

  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    );
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept",
    );
    response.headers.set("Access-Control-Max-Age", "600");
    return withCsp(withCors(response, origin), policy);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  return withCsp(withCors(response, origin), policy);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
