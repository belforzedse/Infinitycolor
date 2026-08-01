import { createBridgeHeaders } from "@repo/auth-core/bridge-signature";
import type {
  BridgeOtpRequestResponse,
  BridgePhoneStatusResponse,
  BridgeVerifiedIdentityResponse,
} from "@repo/auth-core/contracts";
import { getAuthEnv } from "./env";
import { authEvent } from "./event-logger";

export class StrapiBridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reasonCode: string,
  ) {
    super(message);
    this.name = "StrapiBridgeError";
  }
}

export class StrapiBridgeClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const env = getAuthEnv();
    const signed = createBridgeHeaders(env.bridgeSecret, "POST", path, payload);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const startedAt = Date.now();

    try {
      const response = await this.fetchImpl(`${env.strapiInternalUrl}${path}`, {
        method: "POST",
        headers: { ...signed.headers, accept: "application/json" },
        body: signed.body,
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      } & T;
      if (!response.ok) {
        authEvent("bridge_failure", {
          reasonCode: body.error ?? "STRAPI_BRIDGE_REJECTED",
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
        throw new StrapiBridgeError(
          body.message ?? "درخواست احراز هویت ناموفق بود. دوباره تلاش کنید.",
          response.status,
          body.error ?? "STRAPI_BRIDGE_REJECTED",
        );
      }
      authEvent("bridge_success", {
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return body;
    } catch (error) {
      if (error instanceof StrapiBridgeError) throw error;
      authEvent("bridge_failure", {
        reasonCode:
          error instanceof Error && error.name === "AbortError"
            ? "TIMEOUT"
            : "NETWORK_ERROR",
        durationMs: Date.now() - startedAt,
      });
      throw new StrapiBridgeError(
        "ارتباط با سرویس احراز هویت ناموفق بود. دوباره تلاش کنید.",
        503,
        "STRAPI_BRIDGE_UNAVAILABLE",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  phoneStatus(phone: string): Promise<BridgePhoneStatusResponse> {
    return this.post("/api/internal/auth/phone-status", { phone });
  }

  requestOtp(phone: string): Promise<BridgeOtpRequestResponse> {
    return this.post("/api/internal/auth/otp/request", { phone });
  }

  verifyOtp(
    challengeId: string,
    otp: string,
  ): Promise<BridgeVerifiedIdentityResponse> {
    return this.post("/api/internal/auth/otp/verify", { challengeId, otp });
  }

  verifyPassword(
    phone: string,
    password: string,
  ): Promise<BridgeVerifiedIdentityResponse> {
    return this.post("/api/internal/auth/password/verify", { phone, password });
  }

  resetPassword(
    challengeId: string,
    otp: string,
    newPassword: string,
  ): Promise<BridgeVerifiedIdentityResponse> {
    return this.post("/api/internal/auth/password/reset", {
      challengeId,
      otp,
      newPassword,
    });
  }
}
