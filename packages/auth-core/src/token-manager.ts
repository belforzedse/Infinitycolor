import type { BetterAuthTokenResponse } from "./contracts.js";

export interface TokenManagerOptions {
  authOrigin: string;
  fetchImpl?: typeof fetch;
  refreshSkewSeconds?: number;
  now?: () => number;
  isAvailable?: () => boolean;
}

export interface TokenManager {
  getToken(options?: { forceRefresh?: boolean }): Promise<string | null>;
  getTokenOutcome(options?: {
    forceRefresh?: boolean;
  }): Promise<TokenAcquisitionOutcome>;
  peek(): string | null;
  expire(): void;
  clearForLogout(): void;
  authenticatedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response>;
}

export type TokenAcquisitionOutcome =
  | { state: "authenticated"; token: string }
  | { state: "unauthenticated" }
  | { state: "invalidated" }
  | {
      state: "unavailable";
      reasonCode:
        | "browser_unavailable"
        | "timeout"
        | "network"
        | "http_failure"
        | "invalid_response";
      status?: number;
    };

export class TokenAcquisitionError extends Error {
  constructor(
    public readonly reasonCode: string,
    public readonly status?: number,
  ) {
    super("Session recovery is temporarily unavailable");
    this.name = "TokenAcquisitionError";
  }
}

type CachedToken = { value: string; expiresAtMs: number };

/**
 * `Buffer` is referenced through `globalThis` on purpose: a bare `Buffer`
 * identifier makes bundlers inject the `buffer` npm polyfill (plus base64-js
 * and ieee754) into every client chunk that can reach this module. Browsers
 * and Node 16+ both provide `atob`, so the Node path is only a fallback.
 */
function decodeBase64(value: string): string {
  if (typeof atob === "function") return atob(value);
  const nodeBuffer = (
    globalThis as {
      Buffer?: {
        from(
          input: string,
          encoding: string,
        ): { toString(encoding: string): string };
      };
    }
  ).Buffer;
  if (!nodeBuffer)
    throw new Error("No base64 decoder available in this runtime");
  return nodeBuffer.from(value, "base64").toString("utf8");
}

/**
 * Anchors the token's remaining lifetime to this client's own clock (via
 * `iat`) instead of trusting the server's absolute `exp` outright. The API
 * enforces `exp` with zero tolerance (see `validatePinnedClaims` in
 * `better-auth-jwt.ts`), so a client clock running even 10-15s fast/slow can
 * otherwise cache a token as "fresh" past the moment the server considers it
 * expired. Falls back to trusting `exp` directly when `iat` is absent.
 */
function readJwtExpiry(token: string, nowMs: number): number | null {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return null;
  try {
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = decodeBase64(padded);
    const payload = JSON.parse(json) as { exp?: unknown; iat?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }
    if (
      typeof payload.iat === "number" &&
      Number.isFinite(payload.iat) &&
      payload.iat <= payload.exp
    ) {
      return nowMs + (payload.exp - payload.iat) * 1_000;
    }
    return payload.exp * 1_000;
  } catch {
    return null;
  }
}

function normalizedMethod(init?: RequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

export function createTokenManager(options: TokenManagerOptions): TokenManager {
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const authOrigin = new URL(options.authOrigin).origin;
  const refreshSkewMs = (options.refreshSkewSeconds ?? 20) * 1_000;
  const now = options.now ?? Date.now;
  const isAvailable = options.isAvailable ?? (() => true);
  let cached: CachedToken | null = null;
  let acquisition: Promise<TokenAcquisitionOutcome> | null = null;
  let generation = 0;

  const acquire = async (): Promise<TokenAcquisitionOutcome> => {
    const acquisitionGeneration = generation;
    // Plain `fetch` has no timeout: a hung/slow token endpoint (an idle tab
    // resuming, a flaky network) used to leave every caller of `getToken` --
    // including `ApiClient.request`, which only starts its own abort timer
    // *after* headers (and therefore this call) resolve -- awaiting forever
    // with no visible error. The button submitting the form just never
    // updates again. Bound it the same way `updateRouteHint` above does.
    const controller = new AbortController();
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Session deadline exceeded")),
        { once: true },
      );
    });
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await Promise.race([
        fetchImpl(`${authOrigin}/api/auth/token`, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        }),
        interrupted,
      ]);
      if (generation !== acquisitionGeneration) return { state: "invalidated" };
      if (response.status === 401) {
        cached = null;
        return { state: "unauthenticated" };
      }
      if (!response.ok)
        return {
          state: "unavailable",
          reasonCode: "http_failure",
          status: response.status,
        };
      const payload = (await Promise.race([
        response.json(),
        interrupted,
      ])) as Partial<BetterAuthTokenResponse>;
      if (generation !== acquisitionGeneration) return { state: "invalidated" };
      if (controller.signal.aborted)
        return { state: "unavailable", reasonCode: "timeout" };
      if (
        typeof payload.token !== "string" ||
        payload.token.split(".").length !== 3
      )
        return { state: "unavailable", reasonCode: "invalid_response" };
      const expiry = readJwtExpiry(payload.token, now());
      if (!expiry || expiry <= now())
        return { state: "unavailable", reasonCode: "invalid_response" };
      cached = { value: payload.token, expiresAtMs: expiry };
      return { state: "authenticated", token: payload.token };
    } catch (error) {
      if (generation !== acquisitionGeneration) return { state: "invalidated" };
      return {
        state: "unavailable",
        reasonCode: controller.signal.aborted
          ? "timeout"
          : error instanceof SyntaxError
            ? "invalid_response"
            : "network",
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  const getTokenOutcome: TokenManager["getTokenOutcome"] = async ({
    forceRefresh = false,
  } = {}) => {
    if (!isAvailable())
      return { state: "unavailable", reasonCode: "browser_unavailable" };
    if (!forceRefresh && cached && cached.expiresAtMs - refreshSkewMs > now()) {
      return { state: "authenticated", token: cached.value };
    }
    const acquisitionGeneration = generation;
    let pending = acquisition;
    if (!pending) {
      const started = acquire().finally(() => {
        if (acquisition === started) acquisition = null;
      });
      acquisition = started;
      pending = started;
    }
    const outcome = await pending;
    // Refresh starts before expiry. A temporary refresh failure must not discard
    // a JWT that is still usable, but a 401-triggered forced refresh must never
    // fall back to the rejected credential, even when it shares this acquisition.
    const temporaryFailure =
      outcome.state === "unavailable" &&
      (outcome.reasonCode === "network" ||
        outcome.reasonCode === "timeout" ||
        (outcome.reasonCode === "http_failure" &&
          outcome.status !== undefined &&
          (outcome.status === 408 || outcome.status === 429 || outcome.status >= 500)));
    if (
      !forceRefresh &&
      temporaryFailure &&
      generation === acquisitionGeneration &&
      cached &&
      cached.expiresAtMs - now() > 5_000
    ) {
      return { state: "authenticated", token: cached.value };
    }
    return outcome;
  };

  const getToken: TokenManager["getToken"] = async (options) => {
    const outcome = await getTokenOutcome(options);
    if (outcome.state === "authenticated") return outcome.token;
    if (
      outcome.state === "unavailable" &&
      outcome.reasonCode !== "browser_unavailable"
    )
      throw new TokenAcquisitionError(outcome.reasonCode, outcome.status);
    return null;
  };

  const expire = () => {
    cached = null;
  };

  const clearForLogout = () => {
    generation += 1;
    cached = null;
    acquisition = null;
  };

  return {
    getToken,
    getTokenOutcome,
    peek: () => (isAvailable() ? (cached?.value ?? null) : null),
    expire,
    clearForLogout,
    async authenticatedFetch(input, init = {}) {
      const token = await getToken();
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      const firstResponse = await fetchImpl(input, { ...init, headers });

      const method = normalizedMethod(init);
      if (firstResponse.status !== 401 || !["GET", "HEAD"].includes(method)) {
        return firstResponse;
      }

      expire();
      const refreshed = await getToken({ forceRefresh: true });
      if (!refreshed) return firstResponse;
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("authorization", `Bearer ${refreshed}`);
      return fetchImpl(input, { ...init, headers: retryHeaders });
    },
  };
}
