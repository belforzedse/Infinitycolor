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
  peek(): string | null;
  expire(): void;
  clearForLogout(): void;
  authenticatedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response>;
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
  let acquisition: Promise<string | null> | null = null;
  let generation = 0;

  const acquire = async (): Promise<string | null> => {
    const acquisitionGeneration = generation;
    const response = await fetchImpl(`${authOrigin}/api/auth/token`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return null;
    if (!response.ok)
      throw new Error(
        `Central auth token request failed with ${response.status}`,
      );

    const payload = (await response.json()) as Partial<BetterAuthTokenResponse>;
    if (
      typeof payload.token !== "string" ||
      payload.token.split(".").length !== 3
    ) {
      throw new Error("Central auth returned an invalid token response");
    }
    const expiry = readJwtExpiry(payload.token, now());
    if (!expiry || expiry <= now())
      throw new Error("Central auth returned an expired token");

    if (generation !== acquisitionGeneration) return null;
    cached = { value: payload.token, expiresAtMs: expiry };
    return payload.token;
  };

  const getToken: TokenManager["getToken"] = async ({
    forceRefresh = false,
  } = {}) => {
    if (!isAvailable()) return null;
    if (!forceRefresh && cached && cached.expiresAtMs - refreshSkewMs > now()) {
      return cached.value;
    }
    if (acquisition) return acquisition;
    acquisition = acquire().finally(() => {
      acquisition = null;
    });
    return acquisition;
  };

  const expire = () => {
    cached = null;
  };

  const clearForLogout = () => {
    generation += 1;
    cached = null;
  };

  return {
    getToken,
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
