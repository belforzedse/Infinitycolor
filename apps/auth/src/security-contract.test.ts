import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  createBridgeHeaders,
  resolveReturnTarget,
  safeInternalPath,
  sha256Body,
  verifyBridgeSignature,
} from "@repo/auth-core";
import { createTokenManager } from "@repo/auth-core/token-manager";
import { createCentralAuthBrowserClient } from "@repo/auth-core/browser";
import { getAuthEnv, resetAuthEnvForTests } from "./server/env";
import {
  resolveFlowReturnTarget,
  returnTargetFromHeaders,
  sealFlowState,
  unsealFlowState,
  writeFlowState,
} from "./server/flow-state";
import {
  sealApplicationSession,
  unsealApplicationSession,
} from "./server/application-session";
import { proxy } from "./proxy";

function jwt(expSeconds: number, marker: string, iatSeconds?: number): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      exp: expSeconds,
      marker,
      ...(iatSeconds === undefined ? {} : { iat: iatSeconds }),
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("return validation rejects hostile absolute and ambiguous paths", () => {
  assert.equal(safeInternalPath("/account?tab=orders"), "/account?tab=orders");
  for (const value of [
    "//evil.example",
    "/\\evil",
    "https://evil.example/a",
    "%2f%2fevil.example",
    "javascript:alert(1)",
  ]) {
    assert.equal(safeInternalPath(value), null);
  }
  const allowed = ["https://new.infinitycolor.co", "https://infinitycolor.co"];
  assert.equal(
    resolveReturnTarget("https://infinitycolor.co/orders", allowed, allowed[0]),
    "https://infinitycolor.co/orders",
  );
  assert.equal(
    resolveReturnTarget("https://evil.example/orders", allowed, allowed[0]),
    "https://new.infinitycolor.co/",
  );
});

test("bridge signature pins method path timestamp nonce and canonical body", () => {
  const signed = createBridgeHeaders(
    "s".repeat(32),
    "POST",
    "/api/internal/auth/otp/verify",
    {
      otp: "123456",
      challengeId: "challenge",
    },
    1_700_000_000_000,
  );
  const timestamp = signed.headers["x-infinity-auth-timestamp"];
  const nonce = signed.headers["x-infinity-auth-nonce"];
  const bodyDigest = signed.headers["x-infinity-auth-body-sha256"];
  const signature = signed.headers["x-infinity-auth-signature"];
  assert.equal(bodyDigest, sha256Body(signed.body));
  assert.equal(
    verifyBridgeSignature({
      secret: "s".repeat(32),
      timestamp,
      nonce,
      method: "POST",
      path: "/api/internal/auth/otp/verify",
      bodyDigest,
      signature,
    }),
    true,
  );
  assert.equal(
    verifyBridgeSignature({
      secret: "s".repeat(32),
      timestamp,
      nonce,
      method: "POST",
      path: "/api/internal/auth/otp/request",
      bodyDigest,
      signature,
    }),
    false,
  );
});

test("token manager coalesces acquisition and discards a post-logout result", async () => {
  let resolveFetch!: (response: Response) => void;
  let calls = 0;
  const fetchImpl = (() => {
    calls += 1;
    return new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
  }) as typeof fetch;
  const manager = createTokenManager({
    authOrigin: "https://auth.infinitycolor.co",
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
  const first = manager.getToken();
  const second = manager.getToken();
  assert.equal(calls, 1);
  manager.clearForLogout();
  resolveFetch(
    new Response(JSON.stringify({ token: jwt(1_700_000_060, "late") }), {
      status: 200,
    }),
  );
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.equal(manager.peek(), null);
});

test("token manager does not reject a freshly issued token just because the client clock runs ahead", async () => {
  // A client clock running far enough ahead of the server can make a
  // brand-new token's absolute `exp` look already past by client time, even
  // though the token has its full ~60s of real life left. Anchoring to `iat`
  // on the client's own clock (readJwtExpiry) keeps a fresh token usable
  // regardless of clock disagreement between client and server.
  const serverNow = 1_700_000_000;
  const clientNow = (serverNow + 70) * 1_000; // 70s ahead -- more than the 60s TTL
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ token: jwt(serverNow + 60, "skewed", serverNow) }),
      { status: 200 },
    )) as typeof fetch;
  const manager = createTokenManager({
    authOrigin: "https://auth.infinitycolor.co",
    fetchImpl,
    now: () => clientNow,
  });

  const token = await manager.getToken();
  assert.notEqual(token, null);
});

test("browser auth client never acquires a token during server rendering", async () => {
  let calls = 0;
  const client = createCentralAuthBrowserClient({
    authOrigin: "https://auth.infinitycolor.co",
    fetchImpl: (async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch,
  });

  assert.equal(await client.tokenManager.getToken(), null);
  assert.equal(client.tokenManager.peek(), null);
  assert.equal(calls, 0);
});

test("browser auth client can use an application-local token broker", async () => {
  const requests: string[] = [];
  const client = createCentralAuthBrowserClient({
    authOrigin: "https://auth.infinitycolor.co",
    tokenOrigin: "https://infinitygram.co",
    fetchImpl: (async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          token: jwt(Math.floor(Date.now() / 1_000) + 60, "social"),
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: {},
    configurable: true,
  });
  try {
    await client.tokenManager.getToken();
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
  assert.equal(requests[0], "https://infinitygram.co/api/auth/token");
});

test("typed session management wrappers use central auth with no-store credentials", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createCentralAuthBrowserClient({
    authOrigin: "https://auth.infinitycolor.co",
    fetchImpl: (async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await client.listSessions();
  await client.revokeSession("opaque-session-token");
  await client.revokeOtherSessions();
  await client.revokeSessions();

  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      "/api/auth/list-sessions",
      "/api/auth/revoke-session",
      "/api/auth/revoke-other-sessions",
      "/api/auth/revoke-sessions",
    ],
  );
  for (const request of requests) {
    assert.equal(request.init?.credentials, "include");
    assert.equal(request.init?.cache, "no-store");
  }
  assert.equal(requests[0].init?.method, "GET");
  assert.equal(
    requests[1].init?.body,
    JSON.stringify({ token: "opaque-session-token" }),
  );
});

test("authenticated fetch retries one read but never retries a mutation", async () => {
  let tokenNumber = 0;
  let apiGets = 0;
  let apiPosts = 0;
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/auth/token")) {
      tokenNumber += 1;
      return new Response(
        JSON.stringify({
          token: jwt(1_700_000_060 + tokenNumber, String(tokenNumber)),
        }),
        { status: 200 },
      );
    }
    if ((init?.method ?? "GET") === "POST") {
      apiPosts += 1;
      return new Response(null, { status: 401 });
    }
    apiGets += 1;
    return new Response(null, { status: apiGets === 1 ? 401 : 200 });
  }) as typeof fetch;
  const manager = createTokenManager({
    authOrigin: "https://auth.infinitycolor.co",
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
  assert.equal(
    (
      await manager.authenticatedFetch(
        "https://api.infinitycolor.co/api/auth/self",
      )
    ).status,
    200,
  );
  assert.equal(apiGets, 2);
  assert.equal(
    (
      await manager.authenticatedFetch(
        "https://api.infinitycolor.co/api/orders",
        { method: "POST" },
      )
    ).status,
    401,
  );
  assert.equal(apiPosts, 1);
});

test("sealed flow cookie is host-only, HttpOnly, short-lived and tamper evident", () => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    AUTH_DEPLOYMENT_ENV: "production",
    BETTER_AUTH_URL: "https://auth.infinitycolor.co",
    BETTER_AUTH_SECRET: "a".repeat(32),
    AUTH_DATABASE_URL: "postgresql://unused/unused",
    AUTH_FLOW_SECRET: "f".repeat(32),
    AUTH_TRUSTED_STOREFRONT_ORIGINS:
      "https://new.infinitycolor.co,https://infinitycolor.co,https://infinitygram.co",
    AUTH_TRUSTED_ADMIN_ORIGINS: "https://admin.infinitycolor.co",
    AUTH_DEFAULT_STOREFRONT_ORIGIN: "https://new.infinitycolor.co",
    STRAPI_INTERNAL_URL: "https://api.infinitycolor.co",
    AUTH_STRAPI_BRIDGE_SECRET: "b".repeat(32),
    AUTH_JWT_ISSUER: "https://auth.infinitycolor.co",
    AUTH_JWT_AUDIENCE: "https://api.infinitycolor.co",
    AUTH_JWT_TTL_SECONDS: "60",
    AUTH_JWKS_ROTATION_SECONDS: "2592000",
    AUTH_JWKS_GRACE_SECONDS: "86400",
    AUTH_SESSION_TTL_SECONDS: "604800",
  });
  resetAuthEnvForTests();
  assert.equal(getAuthEnv().jwtExpirationTime, "60s");
  const writes: Array<{
    name: string;
    value: string;
    options: Record<string, unknown>;
  }> = [];
  writeFlowState(
    {
      getCookie: () => null,
      setCookie: (name, value, options) =>
        writes.push({ name, value, options }),
    },
    {
      phone: "09123456789",
      purpose: "login",
      returnTo: "https://new.infinitycolor.co/account",
    },
  );
  assert.equal(writes[0].name, "__Host-infinity-auth-flow");
  assert.equal(writes[0].options.httpOnly, true);
  assert.equal(writes[0].options.secure, true);
  assert.equal(writes[0].options.sameSite, "lax");
  assert.equal(writes[0].options.path, "/");
  assert.equal(writes[0].options.maxAge, 600);
  assert.equal("domain" in writes[0].options, false);
  assert.equal(writes[0].value.includes("09123456789"), false);
  const sealed = sealFlowState({
    phone: "09123456789",
    purpose: "login",
    returnTo: "https://new.infinitycolor.co/",
  });
  const tampered = Buffer.from(sealed, "base64url");
  tampered[12] ^= 1;
  assert.equal(unsealFlowState(tampered.toString("base64url")), null);
});

test("application sessions are encrypted, expiring, and bound to one trusted origin", () => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    AUTH_DEPLOYMENT_ENV: "production",
    BETTER_AUTH_URL: "https://auth.infinitycolor.co",
    BETTER_AUTH_SECRET: "a".repeat(32),
    AUTH_DATABASE_URL: "postgresql://unused/unused",
    AUTH_FLOW_SECRET: "f".repeat(32),
    AUTH_TRUSTED_STOREFRONT_ORIGINS:
      "https://new.infinitycolor.co,https://infinitycolor.co,https://infinitygram.co",
    AUTH_TRUSTED_ADMIN_ORIGINS: "https://admin.infinitycolor.co",
    AUTH_DEFAULT_STOREFRONT_ORIGIN: "https://new.infinitycolor.co",
    STRAPI_INTERNAL_URL: "https://api.infinitycolor.co",
    AUTH_STRAPI_BRIDGE_SECRET: "b".repeat(32),
    AUTH_JWT_ISSUER: "https://auth.infinitycolor.co",
    AUTH_JWT_AUDIENCE: "https://api.infinitycolor.co",
    AUTH_JWT_TTL_SECONDS: "60",
    AUTH_JWKS_ROTATION_SECONDS: "2592000",
    AUTH_JWKS_GRACE_SECONDS: "86400",
    AUTH_SESSION_TTL_SECONDS: "604800",
  });
  resetAuthEnvForTests();

  const sessionToken = "central-session-token";
  const sealed = sealApplicationSession({
    sessionToken,
    audience: "https://infinitygram.co",
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
  });
  assert.equal(sealed.includes(sessionToken), false);
  assert.equal(
    unsealApplicationSession(sealed, "https://infinitygram.co")?.sessionToken,
    sessionToken,
  );
  assert.equal(
    unsealApplicationSession(sealed, "https://new.infinitycolor.co"),
    null,
  );

  const tampered = Buffer.from(sealed, "base64url");
  tampered[tampered.length - 1] ^= 1;
  assert.equal(
    unsealApplicationSession(
      tampered.toString("base64url"),
      "https://infinitygram.co",
    ),
    null,
  );
  assert.throws(() =>
    sealApplicationSession({
      sessionToken,
      audience: "https://evil.example",
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
    }),
  );
});

test("production trusts exactly the three first-party storefront origins", () => {
  const productionEnv = {
    NODE_ENV: "production",
    AUTH_DEPLOYMENT_ENV: "production",
    BETTER_AUTH_URL: "https://auth.infinitycolor.co",
    BETTER_AUTH_SECRET: "a".repeat(32),
    AUTH_DATABASE_URL: "postgresql://unused/unused",
    AUTH_FLOW_SECRET: "f".repeat(32),
    AUTH_TRUSTED_ADMIN_ORIGINS: "https://admin.infinitycolor.co",
    AUTH_DEFAULT_STOREFRONT_ORIGIN: "https://new.infinitycolor.co",
    STRAPI_INTERNAL_URL: "https://api.infinitycolor.co",
    AUTH_STRAPI_BRIDGE_SECRET: "b".repeat(32),
    AUTH_JWT_ISSUER: "https://auth.infinitycolor.co",
    AUTH_JWT_AUDIENCE: "https://api.infinitycolor.co",
    AUTH_JWT_TTL_SECONDS: "60",
    AUTH_JWKS_ROTATION_SECONDS: "2592000",
    AUTH_JWKS_GRACE_SECONDS: "86400",
    AUTH_SESSION_TTL_SECONDS: "604800",
  };

  Object.assign(process.env, productionEnv, {
    AUTH_TRUSTED_STOREFRONT_ORIGINS:
      "https://new.infinitycolor.co,https://infinitycolor.co,https://infinitygram.co",
  });
  resetAuthEnvForTests();
  const env = getAuthEnv();
  // Infinitygram shares this auth service, so its origin belongs to the frozen
  // production set. Adding a fourth origin is a deliberate security decision.
  assert.deepEqual(env.trustedStorefrontOrigins, [
    "https://new.infinitycolor.co",
    "https://infinitycolor.co",
    "https://infinitygram.co",
  ]);
  assert.deepEqual(env.trustedApplicationOrigins, [
    "https://new.infinitycolor.co",
    "https://infinitycolor.co",
    "https://infinitygram.co",
    "https://admin.infinitycolor.co",
  ]);

  // The env var cannot widen the set on its own.
  Object.assign(process.env, productionEnv, {
    AUTH_TRUSTED_STOREFRONT_ORIGINS:
      "https://new.infinitycolor.co,https://infinitycolor.co,https://infinitygram.co,https://evil.example",
  });
  resetAuthEnvForTests();
  assert.throws(
    () => getAuthEnv(),
    /production storefront origins must match its frozen allowlist/,
  );

  // Nor can it silently drop one.
  Object.assign(process.env, productionEnv, {
    AUTH_TRUSTED_STOREFRONT_ORIGINS:
      "https://new.infinitycolor.co,https://infinitycolor.co",
  });
  resetAuthEnvForTests();
  assert.throws(
    () => getAuthEnv(),
    /production storefront origins must match its frozen allowlist/,
  );
});

test("staging uses its own exact auth, API, and storefront authorities", () => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    AUTH_DEPLOYMENT_ENV: "staging",
    BETTER_AUTH_URL: "https://auth.staging.infinitycolor.co",
    BETTER_AUTH_SECRET: "a".repeat(32),
    AUTH_DATABASE_URL: "postgresql://unused/unused",
    AUTH_FLOW_SECRET: "f".repeat(32),
    AUTH_TRUSTED_STOREFRONT_ORIGINS: "https://staging.infinitycolor.co",
    AUTH_TRUSTED_ADMIN_ORIGINS: "https://admin.staging.infinitycolor.co",
    AUTH_DEFAULT_STOREFRONT_ORIGIN: "https://staging.infinitycolor.co",
    STRAPI_INTERNAL_URL: "https://api.staging.infinitycolor.co",
    AUTH_STRAPI_BRIDGE_SECRET: "b".repeat(32),
    AUTH_JWT_ISSUER: "https://auth.staging.infinitycolor.co",
    AUTH_JWT_AUDIENCE: "https://api.staging.infinitycolor.co",
    AUTH_JWT_TTL_SECONDS: "60",
    AUTH_JWKS_ROTATION_SECONDS: "2592000",
    AUTH_JWKS_GRACE_SECONDS: "86400",
    AUTH_SESSION_TTL_SECONDS: "604800",
  });
  resetAuthEnvForTests();

  const env = getAuthEnv();
  assert.equal(env.deploymentEnvironment, "staging");
  assert.equal(env.betterAuthUrl, "https://auth.staging.infinitycolor.co");
  assert.equal(env.jwtAudience, "https://api.staging.infinitycolor.co");
  assert.deepEqual(env.trustedStorefrontOrigins, [
    "https://staging.infinitycolor.co",
  ]);
  assert.deepEqual(env.trustedAdminOrigins, [
    "https://admin.staging.infinitycolor.co",
  ]);
  assert.deepEqual(env.trustedApplicationOrigins, [
    "https://staging.infinitycolor.co",
    "https://admin.staging.infinitycolor.co",
  ]);

  const staleLegacyTarget =
    "https://staging.infinitycolor.co/super-admin/orders?page=1";
  const refreshedAdminTarget = returnTargetFromHeaders(
    new Headers({
      referer:
        "https://auth.staging.infinitycolor.co/auth?returnTo=" +
        encodeURIComponent(
          "https://admin.staging.infinitycolor.co/orders?page=2",
        ),
    }),
    staleLegacyTarget,
  );
  assert.equal(
    refreshedAdminTarget,
    "https://admin.staging.infinitycolor.co/orders?page=2",
  );

  assert.equal(
    resolveFlowReturnTarget(
      "https://admin.staging.infinitycolor.co/orders?page=3",
      staleLegacyTarget,
    ),
    "https://admin.staging.infinitycolor.co/orders?page=3",
  );

  assert.equal(
    returnTargetFromHeaders(
      new Headers({
        referer: "https://auth.staging.infinitycolor.co/auth/login",
      }),
      refreshedAdminTarget,
    ),
    refreshedAdminTarget,
  );

  assert.equal(
    returnTargetFromHeaders(
      new Headers({
        referer:
          "https://auth.staging.infinitycolor.co/auth?returnTo=" +
          encodeURIComponent("https://evil.example/super-admin"),
      }),
      refreshedAdminTarget,
    ),
    "https://staging.infinitycolor.co/",
  );
});

test("no-referrer auth initializes the validated return target explicitly", () => {
  const nextConfig = fs.readFileSync(
    path.resolve(process.cwd(), "next.config.ts"),
    "utf8",
  );
  const flowContext = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/auth/auth-flow-context.tsx"),
    "utf8",
  );
  const plugin = fs.readFileSync(
    path.resolve(process.cwd(), "src/server/infinity-plugin.ts"),
    "utf8",
  );

  assert.match(nextConfig, /Referrer-Policy"\s*,\s*value:\s*"no-referrer"/);
  assert.match(flowContext, /"\/infinity\/flow\/start"/);
  assert.match(flowContext, /\{ returnTo \}/);
  assert.match(flowContext, /hasSessionCookie/);
  assert.match(plugin, /"\/infinity\/flow\/start"/);
  assert.match(plugin, /"\/infinity\/otp\/start"/);
  assert.match(plugin, /returnTo:\s*resolveFlowReturnTarget\(/);
});

test("an existing central session resumes through a one-time allowlisted return grant", () => {
  const flowContext = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/auth/auth-flow-context.tsx"),
    "utf8",
  );
  const bootstrap = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/auth/auth-flow-bootstrap.ts"),
    "utf8",
  );
  const plugin = fs.readFileSync(
    path.resolve(process.cwd(), "src/server/infinity-plugin.ts"),
    "utf8",
  );

  assert.match(plugin, /"\/infinity\/session\/continue"/);
  assert.match(plugin, /use:\s*\[sessionMiddleware\]/);
  assert.match(
    plugin,
    /createReturn\(\s*sessionState\.session\.id,\s*flow\.returnTo,\s*\)/,
  );
  assert.match(plugin, /flow\.purpose === "reset"/);
  assert.match(plugin, /clearFlowState\(ctx\)/);
  assert.match(bootstrap, /return "continue-session"/);
  assert.match(
    flowContext,
    /authPost<[\s\S]*?>\("\/infinity\/session\/continue"\)/,
  );
  assert.match(
    flowContext,
    /window\.location\.replace\(continuation\.redirectTo\)/,
  );
});

test("step-up login skips silent session continue so stale list-sessions cannot loop", () => {
  const flowContext = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/auth/auth-flow-context.tsx"),
    "utf8",
  );
  const bootstrap = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/auth/auth-flow-bootstrap.ts"),
    "utf8",
  );
  assert.match(flowContext, /searchParams\.get\("stepUp"\) === "1"/);
  assert.match(bootstrap, /if \(stepUp \|\| sessionKnownAbsent/);
  assert.match(flowContext, /url\.searchParams\.set\("stepUp", "1"\)/);
});

test("Better Auth source freezes absolute sessions and the native secure cookie name", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "src/server/auth.ts"),
    "utf8",
  );
  assert.match(source, /disableSessionRefresh:\s*true/);
  assert.match(source, /cookieCache:\s*\{ enabled: false \}/);
  assert.match(source, /crossSubDomainCookies:\s*\{ enabled: false \}/);
  assert.match(source, /trustedProxyHeaders:\s*false/);
  assert.match(source, /ipAddressHeaders:\s*\["x-real-ip"\]/);
  assert.match(source, /name:\s*"infinity-auth\.session_token"/);
  assert.doesNotMatch(source, /useSecureCookies:\s*false/);
});

test("the production proxy chain preserves only the sanitized client IP for auth", () => {
  const publicNginx = fs.readFileSync(
    path.resolve(process.cwd(), "../../deploy/production/nginx.conf"),
    "utf8",
  );
  const gatewayNginx = fs.readFileSync(
    path.resolve(process.cwd(), "../../deploy/production/gateway.conf"),
    "utf8",
  );
  const compose = fs.readFileSync(
    path.resolve(process.cwd(), "../../deploy/production/compose.yaml"),
    "utf8",
  );

  assert.match(
    publicNginx,
    /server_name auth\.infinitycolor\.co;[\s\S]{0,800}proxy_set_header X-Real-IP \$remote_addr;/,
  );
  assert.match(
    gatewayNginx,
    /server_name auth\.infinitycolor\.co;[\s\S]{0,800}proxy_set_header X-Real-IP \$http_x_real_ip;/,
  );
  assert.match(compose, /127\.0\.0\.1:\$\{GATEWAY_PORT\}:8080/);
});

test("profile completion requires the session and sanitized flow, not pre-auth phone", () => {
  const plugin = fs.readFileSync(
    path.resolve(process.cwd(), "src/server/infinity-plugin.ts"),
    "utf8",
  );
  assert.match(plugin, /if \(!flow \|\| !sessionState\)/);
  assert.doesNotMatch(plugin, /if \(!flow\?\.phone \|\| !sessionState\)/);
});

test("remember-me picks the session TTL at creation without reviving sliding renewal", () => {
  const plugin = fs.readFileSync(
    path.resolve(process.cwd(), "src/server/infinity-plugin.ts"),
    "utf8",
  );
  const auth = fs.readFileSync(
    path.resolve(process.cwd(), "src/server/auth.ts"),
    "utf8",
  );

  // Only an explicit `false` shortens the session, so clients that predate the
  // flag keep the seven-day session they already had.
  assert.match(plugin, /const dontRememberMe = rememberMe === false;/);
  // The choice must reach both the database row and the cookie, or the two
  // would disagree about when the session ends.
  assert.match(plugin, /createSession\(\s*user\.id,\s*dontRememberMe,\s*\)/);
  assert.match(
    plugin,
    /setSessionCookie\(ctx, \{ session, user \}, dontRememberMe\)/,
  );
  // Both credential endpoints must accept the flag.
  assert.match(
    plugin,
    /otp:\s*otpSchema,\s*rememberMe:\s*z\.boolean\(\)\.optional\(\)/,
  );
  assert.match(
    plugin,
    /password:\s*passwordSchema,\s*\n\s*rememberMe:\s*z\.boolean\(\)\.optional\(\),/,
  );
  // Remember-me must not become a licence to extend sessions after the fact.
  assert.match(auth, /disableSessionRefresh:\s*true/);
});

test("credentialed CORS echoes only an explicitly trusted application origin", () => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    BETTER_AUTH_URL: "https://auth.infinitycolor.co",
    AUTH_TRUSTED_STOREFRONT_ORIGINS:
      "https://new.infinitycolor.co,https://infinitycolor.co,https://infinitygram.co",
    AUTH_TRUSTED_ADMIN_ORIGINS: "https://admin.infinitycolor.co",
    AUTH_DEPLOYMENT_ENV: "production",
  });

  const allowed = proxy(
    new NextRequest("https://auth.infinitycolor.co/api/auth/token", {
      headers: { origin: "https://new.infinitycolor.co" },
    }),
  );
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "https://new.infinitycolor.co",
  );
  assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
  assert.match(allowed.headers.get("vary") ?? "", /Origin/i);

  const adminAllowed = proxy(
    new NextRequest("https://auth.infinitycolor.co/api/auth/token", {
      headers: { origin: "https://admin.infinitycolor.co" },
    }),
  );
  assert.equal(
    adminAllowed.headers.get("access-control-allow-origin"),
    "https://admin.infinitycolor.co",
  );

  const rejected = proxy(
    new NextRequest("https://auth.infinitycolor.co/api/auth/token", {
      headers: { origin: "https://evil.example" },
    }),
  );
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  assert.notEqual(rejected.headers.get("access-control-allow-origin"), "*");
});

test("a password reset revokes every session for the identity", () => {
  const plugin = fs.readFileSync(
    path.resolve(process.cwd(), "src/server/infinity-plugin.ts"),
    "utf8",
  );

  // docs/auth/architecture.md promises that a reset revokes every session. Nothing
  // pinned that promise before, so a regression would have been silent.
  assert.match(plugin, /"\/infinity\/password\/reset"/);
  assert.match(
    plugin,
    /deleteUserSessions\(\s*identity\.betterAuthUserId,\s*\)/,
  );
  assert.match(plugin, /deleteSessionCookie\(ctx\)/);
  assert.match(plugin, /reasonCode: "PASSWORD_RESET"/);
});

test("strapi's password reset is reachable only through the signed bridge", () => {
  const routes = fs.readFileSync(
    path.resolve(process.cwd(), "../backend/src/api/auth/routes/auth.ts"),
    "utf8",
  );

  // Strapi cannot touch auth.sessions, so a browser-reachable reset there would change
  // the password and leave every session alive.
  const resetRoute = routes.slice(
    routes.indexOf('path: "/auth/reset-password"'),
  );
  assert.match(
    resetRoute.slice(0, resetRoute.indexOf("},\n    {") + 1 || undefined),
    /api::internal-auth\.verify-bridge/,
  );
});

test("typed token outcomes preserve temporary failures and clear only a confirmed 401", async () => {
  let status = 200;
  const manager = createTokenManager({
    authOrigin: "https://auth.test",
    now: () => 1_700_000_000_000,
    fetchImpl: (async () =>
      status === 200
        ? new Response(JSON.stringify({ token: jwt(1_700_000_060, "valid") }))
        : new Response(null, { status })) as typeof fetch,
  });
  assert.equal((await manager.getTokenOutcome()).state, "authenticated");
  const cached = manager.peek();
  status = 503;
  assert.deepEqual(await manager.getTokenOutcome({ forceRefresh: true }), {
    state: "unavailable",
    reasonCode: "http_failure",
    status: 503,
  });
  assert.equal(manager.peek(), cached);
  await assert.rejects(manager.getToken({ forceRefresh: true }), {
    name: "TokenAcquisitionError",
    status: 503,
  });
  status = 401;
  assert.deepEqual(await manager.getTokenOutcome({ forceRefresh: true }), {
    state: "unauthenticated",
  });
  assert.equal(manager.peek(), null);
});
test("token timeout remains active while reading the response body", async () => {
  const manager = createTokenManager({
    authOrigin: "https://auth.test",
    fetchImpl: (async (_input, init) =>
      ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            ),
          ),
      }) as Response) as typeof fetch,
  });
  assert.deepEqual(await manager.getTokenOutcome(), {
    state: "unavailable",
    reasonCode: "timeout",
  });
});

test("early refresh can retain a still-valid token only for temporary failures", async () => {
  for (const failure of ["network", 503, 403, "invalid_response"] as const) {
    let now = 1_700_000_000_000;
    let calls = 0;
    const token = jwt(1_700_000_060, "cached", 1_700_000_000);
    const manager = createTokenManager({
      authOrigin: "https://auth.test",
      now: () => now,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return Response.json({ token });
        if (failure === "network")
          throw new TypeError("connection unavailable");
        if (failure === "invalid_response") return Response.json({ token: "invalid" });
        return new Response(null, { status: failure });
      }) as typeof fetch,
    });
    assert.equal(await manager.getToken(), token);
    now += 45_000;
    const outcome = await manager.getTokenOutcome();
    assert.equal(
      outcome.state,
      failure === 403 || failure === "invalid_response" ? "unavailable" : "authenticated",
      `early refresh outcome for ${failure}`,
    );
    now += 10_000;
    assert.equal((await manager.getTokenOutcome()).state, "unavailable");
    now += 5_000;
    assert.equal((await manager.getTokenOutcome()).state, "unavailable");
  }
});

test("a forced refresh never shares the cached-token fallback with an ordinary caller", async () => {
  let now = 1_700_000_000_000;
  let resolveRefresh!: (response: Response) => void;
  let calls = 0;
  const token = jwt(1_700_000_060, "cached", 1_700_000_000);
  const manager = createTokenManager({
    authOrigin: "https://auth.test",
    now: () => now,
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return Response.json({ token });
      return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    }) as typeof fetch,
  });
  assert.equal(await manager.getToken(), token);
  now += 45_000;
  const ordinary = manager.getTokenOutcome();
  const forced = manager.getTokenOutcome({ forceRefresh: true });
  assert.equal(calls, 2);
  resolveRefresh(new Response(null, { status: 503 }));
  assert.deepEqual(await ordinary, { state: "authenticated", token });
  assert.deepEqual(await forced, { state: "unavailable", reasonCode: "http_failure", status: 503 });
});

test("logout invalidates an early-refresh fallback and a confirmed 401 clears it", async () => {
  let now = 1_700_000_000_000;
  let resolveRefresh!: (response: Response) => void;
  let calls = 0;
  const token = jwt(1_700_000_060, "cached", 1_700_000_000);
  const manager = createTokenManager({
    authOrigin: "https://auth.test",
    now: () => now,
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return Response.json({ token });
      if (calls === 2)
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      return new Response(null, { status: 401 });
    }) as typeof fetch,
  });
  assert.equal(await manager.getToken(), token);
  now += 45_000;
  const pending = manager.getTokenOutcome();
  manager.clearForLogout();
  resolveRefresh(new Response(null, { status: 503 }));
  assert.deepEqual(await pending, { state: "invalidated" });
  assert.equal(manager.peek(), null);
  assert.deepEqual(await manager.getTokenOutcome(), { state: "unauthenticated" });
  assert.equal(manager.peek(), null);
});

test("a changed identity can acquire immediately without an old result overwriting it", async () => {
  const oldToken = jwt(Math.floor(Date.now() / 1000) + 120, "old");
  const newToken = jwt(Math.floor(Date.now() / 1000) + 121, "new");
  let resolveOld!: (value: Response) => void;
  let calls = 0;
  const manager = createTokenManager({
    authOrigin: "https://auth.test",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1)
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      return new Response(JSON.stringify({ token: newToken }));
    },
  });
  const pending = manager.getTokenOutcome();
  manager.clearForLogout();
  assert.deepEqual(await manager.getTokenOutcome(), {
    state: "authenticated",
    token: newToken,
  });
  resolveOld(new Response(JSON.stringify({ token: oldToken })));
  assert.deepEqual(await pending, { state: "invalidated" });
  assert.equal(manager.peek(), newToken);
});


test("return validation preserves only explicitly trusted HTTP loopback targets", () => {
  const fallback = "https://infinitycolor.co";
  for (const origin of ["http://localhost:2891", "http://127.0.0.1:2891", "http://[::1]:2891"]) {
    const target = origin + "/orders?page=2#details";
    assert.equal(resolveReturnTarget(target, [fallback, origin], fallback), target);
    assert.equal(resolveReturnTarget(target, [fallback], fallback), fallback + "/");
  }
  const allowed = [fallback, "http://localhost:2891", "http://internal.example", "http://192.168.1.2"];
  for (const target of [
    "http://localhost:2892/orders",
    "http://localhost.evil.example:2891/orders",
    "http://localhost:2891@evil.example/orders",
    "http://internal.example/orders",
    "http://192.168.1.2/orders",
    "http://infinitycolor.co/orders",
    "ftp://localhost:2891/orders",
  ]) {
    assert.equal(resolveReturnTarget(target, allowed, fallback), fallback + "/");
  }
});
