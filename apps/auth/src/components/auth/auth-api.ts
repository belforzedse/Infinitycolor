"use client";

interface AuthApiErrorBody {
  message?: string;
  error?: { message?: string } | string;
}

export class AuthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
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
      nested || payload.message || "احراز هویت ناموفق بود. دوباره تلاش کنید.",
      response.status,
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
    );
  }
  return payload;
}
