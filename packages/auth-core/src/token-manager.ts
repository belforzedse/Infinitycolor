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

function readJwtExpiry(token: string): number | null {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return null;
  try {
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1_000
      : null;
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
  const refreshSkewMs = (options.refreshSkewSeconds ?? 10) * 1_000;
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
    const expiry = readJwtExpiry(payload.token);
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
