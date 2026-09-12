"use client";

interface AuthApiErrorBody {
  message?: string;
  error?: { message?: string } | string;
}

export class AuthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw =
    response.headers.get("retry-after") ??
    response.headers.get("x-retry-after");
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, 120);
}

export async function authPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await response.json().catch(() => ({}))) as T &
    AuthApiErrorBody;
  if (!response.ok) {
    const nested =
      typeof payload.error === "object" ? payload.error?.message : undefined;
    throw new AuthApiError(
      response.status === 429
        ? "درخواست‌های زیادی ارسال شده است. کمی بعد دوباره تلاش کنید."
        : nested ||
          payload.message ||
          "احراز هویت ناموفق بود. دوباره تلاش کنید.",
      response.status,
      retryAfterSeconds(response),
    );
  }
  return payload;
}

export async function authGet<T>(path: string): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const payload = (await response.json().catch(() => ({}))) as T &
    AuthApiErrorBody;
  if (!response.ok) {
    const nested =
      typeof payload.error === "object" ? payload.error?.message : undefined;
    throw new AuthApiError(
      nested || payload.message || "بازیابی جریان احراز هویت ناموفق بود",
      response.status,
      retryAfterSeconds(response),
    );
  }
  return payload;
}
