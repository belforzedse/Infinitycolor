import {
  AUTH_STATE_CHANNEL,
  AUTH_STATE_EVENT,
  STALE_AUTH_STORAGE_KEYS,
  type AuthStateEvent,
  type AuthStateEventDetail,
  type AuthSuccessResponse,
  type OtpRequestResponse,
  type PhoneStatusResponse,
} from "./contracts.js";
import { createTokenManager } from "./token-manager.js";

export function clearStaleBrowserCredentials(): void {
  if (typeof window === "undefined") return;
  for (const key of STALE_AUTH_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage can be unavailable in hardened/private browser modes.
    }
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage can be unavailable in hardened/private browser modes.
    }
  }
}

export function publishAuthState(type: AuthStateEvent): void {
  if (typeof window === "undefined") return;
  const detail: AuthStateEventDetail = { type, at: Date.now() };
  window.dispatchEvent(
    new CustomEvent<AuthStateEventDetail>(AUTH_STATE_EVENT, { detail }),
  );
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(AUTH_STATE_CHANNEL);
    channel.postMessage(detail);
    channel.close();
  }
}

export function subscribeToAuthState(
  listener: (event: AuthStateEventDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onWindowEvent = (event: Event) => {
    listener((event as CustomEvent<AuthStateEventDetail>).detail);
  };
  window.addEventListener(AUTH_STATE_EVENT, onWindowEvent);

  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(AUTH_STATE_CHANNEL)
      : null;
  if (channel)
    channel.onmessage = (event: MessageEvent<AuthStateEventDetail>) =>
      listener(event.data);

  return () => {
    window.removeEventListener(AUTH_STATE_EVENT, onWindowEvent);
    channel?.close();
  };
}

export interface CentralAuthBrowserClientOptions {
  authOrigin: string;
  fetchImpl?: typeof fetch;
}

export interface CentralAuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type CentralAuthBrowserError = Error & {
  status: number;
  code?: string;
};

export function createCentralAuthBrowserClient(
  options: CentralAuthBrowserClientOptions,
) {
  const authOrigin = new URL(options.authOrigin).origin;
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const request = async <T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<T> => {
    const method = options.method ?? "POST";
    const response = await fetchImpl(`${authOrigin}${path}`, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body:
        method === "GET" || options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
    });
    const payload = (await response.json().catch(() => ({}))) as T & {
      message?: string;
      code?: string;
    };
    if (!response.ok)
      throw Object.assign(
        new Error(payload.message ?? "Authentication failed"),
        { status: response.status, code: payload.code },
      ) as CentralAuthBrowserError;
    return payload;
  };

  return {
    tokenManager: createTokenManager({
      authOrigin,
      fetchImpl,
      isAvailable: () => typeof window !== "undefined",
    }),
    phoneStatus: (phone: string) =>
      request<PhoneStatusResponse>("/api/auth/infinity/phone-status", {
        body: { phone },
      }),
    requestOtp: (phone: string) =>
      request<OtpRequestResponse>("/api/auth/infinity/otp/request", {
        body: { phone },
      }),
    // `rememberMe` omitted means remember: the auth service only shortens the
    // session when it is explicitly false, so existing callers are unchanged.
    verifyOtp: (otp: string, rememberMe?: boolean) =>
      request<AuthSuccessResponse>("/api/auth/infinity/otp/verify", {
        body: { otp, ...(rememberMe === undefined ? {} : { rememberMe }) },
      }),
    signInWithPassword: (phone: string, password: string, rememberMe?: boolean) =>
      request<AuthSuccessResponse>("/api/auth/infinity/password/sign-in", {
        body: {
          phone,
          password,
          ...(rememberMe === undefined ? {} : { rememberMe }),
        },
      }),
    resetPassword: (otp: string, newPassword: string) =>
      request<AuthSuccessResponse>("/api/auth/infinity/password/reset", {
        body: { otp, newPassword },
      }),
    listSessions: () =>
      request<CentralAuthSession[]>("/api/auth/list-sessions", {
        method: "GET",
      }),
    revokeSession: (token: string) =>
      request<{ status: boolean }>("/api/auth/revoke-session", {
        body: { token },
      }),
    revokeOtherSessions: () =>
      request<{ status: boolean }>("/api/auth/revoke-other-sessions"),
    revokeSessions: () =>
      request<{ status: boolean }>("/api/auth/revoke-sessions"),
  };
}
