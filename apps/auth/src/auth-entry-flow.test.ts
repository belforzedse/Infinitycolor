import assert from "node:assert/strict";
import test from "node:test";
import { getSessionCookie } from "better-auth/cookies";
import { AuthApiError, authPost } from "./components/auth/auth-api";
import {
  authBootstrapAction,
  classifyBootstrapFailure,
} from "./components/auth/auth-flow-bootstrap";
import { resetAuthEnvForTests } from "./server/env";
import { safeAuthRequestId } from "./server/event-logger";
import { startInfinityOtpFlow } from "./server/infinity-plugin";
import { StrapiBridgeClient, StrapiBridgeError } from "./server/bridge-client";
import { unsealFlowState } from "./server/flow-state";

function setTestEnvironment() {
  Object.assign(process.env, {
    NODE_ENV: "test",
    AUTH_DEPLOYMENT_ENV: "development",
    BETTER_AUTH_URL: "http://localhost:2889",
    BETTER_AUTH_SECRET: "a".repeat(32),
    AUTH_DATABASE_URL: "postgresql://unused/unused",
    AUTH_FLOW_SECRET: "f".repeat(32),
    AUTH_TRUSTED_STOREFRONT_ORIGINS: "http://localhost:2888",
    AUTH_TRUSTED_ADMIN_ORIGINS: "http://localhost:2891",
    AUTH_DEFAULT_STOREFRONT_ORIGIN: "http://localhost:2888",
    STRAPI_INTERNAL_URL: "http://localhost:1337",
    AUTH_STRAPI_BRIDGE_SECRET: "b".repeat(32),
    AUTH_JWT_ISSUER: "http://localhost:2889",
    AUTH_JWT_AUDIENCE: "http://localhost:1337",
    AUTH_JWT_TTL_SECONDS: "60",
    AUTH_JWKS_ROTATION_SECONDS: "2592000",
    AUTH_JWKS_GRACE_SECONDS: "86400",
    AUTH_SESSION_TTL_SECONDS: "604800",
  });
  resetAuthEnvForTests();
}

test("fresh entry skips bootstrap while a cookie hint still requires authority", () => {
  const base = {
    pathname: "/auth",
    stepUp: false,
    flowInitialized: false,
    sessionKnownAbsent: false,
  };
  assert.equal(
    authBootstrapAction({ ...base, hasSessionCookie: false }),
    "none",
  );
  assert.equal(
    authBootstrapAction({ ...base, hasSessionCookie: true }),
    "continue-session",
  );
  assert.equal(
    authBootstrapAction({ ...base, hasSessionCookie: true, stepUp: true }),
    "none",
  );
  assert.equal(
    authBootstrapAction({
      ...base,
      pathname: "/auth/forgot-password",
      hasSessionCookie: true,
    }),
    "none",
  );
});

test("deep links hydrate once and internal navigation reuses initialized flow", () => {
  const input = {
    pathname: "/auth/login/otp",
    hasSessionCookie: false,
    stepUp: false,
    sessionKnownAbsent: true,
  };
  assert.equal(
    authBootstrapAction({ ...input, flowInitialized: false }),
    "hydrate-flow",
  );
  assert.equal(
    authBootstrapAction({ ...input, flowInitialized: true }),
    "none",
  );
});

test("only authoritative 401 reveals credentials after continuation", () => {
  assert.equal(classifyBootstrapFailure("continuation", 401), "credentials");
  assert.equal(classifyBootstrapFailure("flow", 401), "retry");
  for (const status of [0, 400, 403, 429, 500, 503]) {
    assert.equal(classifyBootstrapFailure("continuation", status), "retry");
  }
});

test("cookie presence remains a non-authoritative boolean hint", () => {
  const headers = new Headers({
    cookie: "__Secure-infinity-auth.session_token=forged-or-stale-value",
  });
  const hint = Boolean(
    getSessionCookie(headers, {
      cookiePrefix: "infinity-auth",
      cookieName: "session_token",
    }),
  );
  assert.equal(hint, true);
  assert.equal(typeof hint, "boolean");
});

test("PII-shaped inbound request IDs are replaced before logging", () => {
  const requestId = safeAuthRequestId("09123456789");
  assert.notEqual(requestId, "09123456789");
  assert.match(
    requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("OTP start clears the previous challenge before one bridge request", async () => {
  setTestEnvironment();
  let sealedCookie = "";
  let writes = 0;
  let bridgeCalls = 0;
  const ctx = {
    body: {
      phone: "09123456789",
      purpose: "login" as const,
      returnTo: "https://evil.example/account",
    },
    headers: new Headers({
      origin: "http://localhost:2889",
      "x-request-id": "00000000-0000-4000-8000-000000000001",
    }),
    context: {
      isTrustedOrigin: (origin: string) => origin === "http://localhost:2889",
    },
    getCookie: () => sealedCookie,
    setCookie: (_name: string, value: string) => {
      sealedCookie = value;
      writes += 1;
    },
  };
  const bridge = {
    requestOtp: async (phone: string, requestId?: string) => {
      bridgeCalls += 1;
      assert.equal(phone, "09123456789");
      assert.equal(requestId, "00000000-0000-4000-8000-000000000001");
      const challengeFree = unsealFlowState(sealedCookie);
      assert.equal(challengeFree?.challengeId, undefined);
      assert.equal(challengeFree?.returnTo, "http://localhost:2888/");
      return { challengeId: "challenge.accepted" };
    },
  };

  assert.deepEqual(await startInfinityOtpFlow(ctx, bridge), {
    message: "otp sent",
  });
  assert.equal(bridgeCalls, 1);
  assert.equal(writes, 2);
  const accepted = unsealFlowState(sealedCookie);
  assert.equal(accepted?.challengeId, "challenge.accepted");
  assert.equal(accepted?.purpose, "login");
  assert.equal(accepted?.returnTo, "http://localhost:2888/");
});

test("OTP start rejects cross-origin requests before cookie or bridge work", async () => {
  setTestEnvironment();
  let writes = 0;
  let bridgeCalls = 0;
  const ctx = {
    body: {
      phone: "09123456789",
      purpose: "login" as const,
      returnTo: null,
    },
    headers: new Headers({ origin: "https://evil.example" }),
    context: { isTrustedOrigin: () => false },
    getCookie: () => null,
    setCookie: () => {
      writes += 1;
    },
  };
  await assert.rejects(
    startInfinityOtpFlow(ctx, {
      requestOtp: async () => {
        bridgeCalls += 1;
        return { challengeId: "unreachable" };
      },
    }),
    (error: unknown) => error instanceof Error && error.name === "APIError",
  );
  assert.equal(writes, 0);
  assert.equal(bridgeCalls, 0);
});

test("failed OTP delivery leaves only challenge-free flow state", async () => {
  setTestEnvironment();
  let sealedCookie = "";
  let writes = 0;
  const ctx = {
    body: {
      phone: "09123456789",
      purpose: "reset" as const,
      returnTo: "http://localhost:2888/account",
    },
    headers: new Headers({ origin: "http://localhost:2889" }),
    context: { isTrustedOrigin: () => true },
    getCookie: () => sealedCookie,
    setCookie: (_name: string, value: string) => {
      sealedCookie = value;
      writes += 1;
    },
  };
  await assert.rejects(
    startInfinityOtpFlow(ctx, {
      requestOtp: async () => {
        throw new StrapiBridgeError(
          "ارسال کد تأیید ناموفق بود. دوباره تلاش کنید.",
          502,
          "OTP_SEND_FAILED",
        );
      },
    }),
    (error: unknown) => error instanceof Error && error.name === "APIError",
  );
  assert.equal(writes, 1);
  const failed = unsealFlowState(sealedCookie);
  assert.equal(failed?.challengeId, undefined);
  assert.equal(failed?.purpose, "reset");
});

test("OTP start propagates a bounded Retry-After through its public error", async () => {
  setTestEnvironment();
  const ctx = {
    body: {
      phone: "09123456789",
      purpose: "login" as const,
      returnTo: null,
    },
    headers: new Headers({ origin: "http://localhost:2889" }),
    context: { isTrustedOrigin: () => true },
    getCookie: () => null,
    setCookie: () => undefined,
  };
  await assert.rejects(
    startInfinityOtpFlow(ctx, {
      requestOtp: async () => {
        throw new StrapiBridgeError(
          "درخواست‌های زیادی ارسال شده است. کمی بعد دوباره تلاش کنید.",
          429,
          "OTP_PHONE_COOLDOWN",
          43,
        );
      },
    }),
    (error: unknown) => {
      const publicError = error as {
        statusCode?: number;
        headers?: Record<string, string>;
        body?: { message?: string };
      };
      assert.equal(publicError.statusCode, 429);
      assert.equal(publicError.headers?.["Retry-After"], "43");
      assert.equal(
        publicError.body?.message,
        "درخواست‌های زیادی ارسال شده است. کمی بعد دوباره تلاش کنید.",
      );
      return true;
    },
  );
});

test("bridge preserves a bounded Retry-After without exposing challenge data", async () => {
  setTestEnvironment();
  const bridge = new StrapiBridgeClient(
    (async () =>
      new Response(
        JSON.stringify({
          message: "درخواست‌های زیادی ارسال شده است. کمی بعد دوباره تلاش کنید.",
          error: "OTP_PHONE_COOLDOWN",
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "43",
          },
        },
      )) as typeof fetch,
  );
  await assert.rejects(
    bridge.requestOtp("09123456789", "00000000-0000-4000-8000-000000000002"),
    (error: unknown) => {
      assert.ok(error instanceof StrapiBridgeError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterSeconds, 43);
      return true;
    },
  );
});

test("bridge logging rejects untrusted reason-code text", async () => {
  setTestEnvironment();
  const bridge = new StrapiBridgeClient(
    (async () =>
      new Response(
        JSON.stringify({
          message: "احراز هویت ناموفق بود. دوباره تلاش کنید.",
          error: "raw identifier 09123456789",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
  );
  await assert.rejects(
    bridge.requestOtp("09123456789", "00000000-0000-4000-8000-000000000003"),
    (error: unknown) => {
      assert.ok(error instanceof StrapiBridgeError);
      assert.equal(error.reasonCode, "STRAPI_BRIDGE_REJECTED");
      return true;
    },
  );
});

test("client clamps Retry-After without exposing response details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "internal limiter detail" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "999",
      },
    })) as typeof fetch;
  try {
    await assert.rejects(
      authPost("/infinity/otp/start", {}),
      (error: unknown) => {
        assert.ok(error instanceof AuthApiError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterSeconds, 120);
        assert.equal(
          error.message,
          "درخواست‌های زیادی ارسال شده است. کمی بعد دوباره تلاش کنید.",
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
