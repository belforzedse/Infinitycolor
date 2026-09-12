import { createBridgeHeaders } from "@repo/auth-core/bridge-signature";
import type {
  BridgeOtpRequestResponse,
  BridgeOtpVerifiedIdentityResponse,
  BridgePhoneStatusResponse,
  BridgeVerifiedIdentityResponse,
} from "@repo/auth-core/contracts";
import { getAuthEnv } from "./env";
import { authEvent, safeAuthRequestId } from "./event-logger";

function bridgeReasonCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z0-9_:-]{1,80}$/.test(value)
    ? value
    : "STRAPI_BRIDGE_REJECTED";
}

export class StrapiBridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reasonCode: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "StrapiBridgeError";
  }
}

export class StrapiBridgeClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async post<T>(
    path: string,
    payload: unknown,
    operation: string,
    suppliedRequestId?: string,
  ): Promise<T> {
    const requestId = safeAuthRequestId(suppliedRequestId);
    const env = getAuthEnv();
    const signed = createBridgeHeaders(env.bridgeSecret, "POST", path, payload);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const startedAt = Date.now();

    try {
      const response = await this.fetchImpl(`${env.strapiInternalUrl}${path}`, {
        method: "POST",
        headers: {
          ...signed.headers,
          accept: "application/json",
          "x-request-id": requestId,
        },
        body: signed.body,
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      } & T;
      if (!response.ok) {
        const reasonCode = bridgeReasonCode(body.error);
        const retryAfterHeader = response.headers.get("retry-after");
        const parsedRetryAfter =
          retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim())
            ? Number.parseInt(retryAfterHeader, 10)
            : undefined;
        const retryAfterSeconds =
          parsedRetryAfter && parsedRetryAfter > 0
            ? Math.min(parsedRetryAfter, 120)
            : undefined;
        authEvent("bridge_failure", {
          operation,
          requestId,
          reasonCode,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
        throw new StrapiBridgeError(
          body.message ?? "درخواست احراز هویت ناموفق بود. دوباره تلاش کنید.",
          response.status,
          reasonCode,
          retryAfterSeconds,
        );
      }
      authEvent("bridge_success", {
        operation,
        requestId,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return body;
    } catch (error) {
      if (error instanceof StrapiBridgeError) throw error;
      authEvent("bridge_failure", {
        operation,
        requestId,
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
    return this.post(
      "/api/internal/auth/phone-status",
      { phone },
      "strapi_phone_status_bridge",
    );
  }

  requestOtp(
    phone: string,
    requestId?: string,
  ): Promise<BridgeOtpRequestResponse> {
    return this.post(
      "/api/internal/auth/otp/request",
      { phone },
      "strapi_otp_bridge",
      requestId,
    );
  }

  verifyOtp(
    challengeId: string,
    otp: string,
  ): Promise<BridgeOtpVerifiedIdentityResponse> {
    return this.post(
      "/api/internal/auth/otp/verify",
      { challengeId, otp },
      "strapi_otp_verify_bridge",
    );
  }

  verifyPassword(
    phone: string,
    password: string,
  ): Promise<BridgeVerifiedIdentityResponse> {
    return this.post(
      "/api/internal/auth/password/verify",
      { phone, password },
      "strapi_password_bridge",
    );
  }

  resetPassword(
    challengeId: string,
    otp: string,
    newPassword: string,
  ): Promise<BridgeVerifiedIdentityResponse> {
    return this.post(
      "/api/internal/auth/password/reset",
      {
        challengeId,
        otp,
        newPassword,
      },
      "strapi_password_reset_bridge",
    );
  }
}
