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
import { proxy } from "./proxy";

function jwt(expSeconds: number, marker: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: expSeconds, marker }),
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
  assert.equal(requests[1].init?.body, JSON.stringify({ token: "opaque-session-token" }));
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
      "https://new.infinitycolor.co,https://infinitycolor.co",
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
    path.resolve(
      process.cwd(),
      "src/components/auth/auth-flow-context.tsx",
    ),
    "utf8",
  );
  const plugin = fs.readFileSync(
    path.resolve(process.cwd(), "src/server/infinity-plugin.ts"),
    "utf8",
  );

  assert.match(nextConfig, /Referrer-Policy"\s*,\s*value:\s*"no-referrer"/);
  assert.match(flowContext, /authPost<\{ phone: string \| null \}>\("\/infinity\/flow\/start", \{ returnTo \}\)/);
  assert.match(plugin, /"\/infinity\/flow\/start"/);
  assert.match(plugin, /returnTo:\s*resolveFlowReturnTarget\(/);
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
  assert.match(source, /name:\s*"infinity-auth\.session_token"/);
  assert.doesNotMatch(source, /useSecureCookies:\s*false/);
});

test("credentialed CORS echoes only an explicitly trusted application origin", () => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    BETTER_AUTH_URL: "https://auth.infinitycolor.co",
    AUTH_TRUSTED_STOREFRONT_ORIGINS:
      "https://new.infinitycolor.co,https://infinitycolor.co",
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
