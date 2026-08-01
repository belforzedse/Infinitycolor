import {
  AUTH_STATE_CHANNEL,
  AUTH_STATE_EVENT,
  STALE_AUTH_STORAGE_KEYS,
  type AuthStateEvent,
  type AuthStateEventDetail,
  type AuthSuccessResponse,
  type OtpRequestResponse,
  type PhoneStatusResponse,
} from "./contracts";
import { createTokenManager } from "./token-manager";

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

export function createCentralAuthBrowserClient(
  options: CentralAuthBrowserClientOptions,
) {
  const authOrigin = new URL(options.authOrigin).origin;
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const request = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetchImpl(`${authOrigin}${path}`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as T & {
      message?: string;
    };
    if (!response.ok)
      throw Object.assign(
        new Error(payload.message ?? "Authentication failed"),
        { status: response.status },
      );
    return payload;
  };

  return {
    tokenManager: createTokenManager({ authOrigin, fetchImpl }),
    phoneStatus: (phone: string) =>
      request<PhoneStatusResponse>("/api/auth/infinity/phone-status", {
        phone,
      }),
    requestOtp: (phone: string) =>
      request<OtpRequestResponse>("/api/auth/infinity/otp/request", { phone }),
    verifyOtp: (otp: string) =>
      request<AuthSuccessResponse>("/api/auth/infinity/otp/verify", { otp }),
    signInWithPassword: (phone: string, password: string) =>
      request<AuthSuccessResponse>("/api/auth/infinity/password/sign-in", {
        phone,
        password,
      }),
    resetPassword: (otp: string, newPassword: string) =>
      request<AuthSuccessResponse>("/api/auth/infinity/password/reset", {
        otp,
        newPassword,
      }),
  };
}
