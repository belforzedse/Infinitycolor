/** @jest-environment node */

import { NextRequest } from "next/server";
import { GET } from "./route";

describe("Infinitygram auth callback", () => {
  beforeEach(() => {
    process.env.AUTH_SERVER_ORIGIN = "https://auth.infinitycolor.co";
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stores the opaque application session in an HttpOnly cookie", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          returnTo: "https://infinitygram.co/",
          applicationSession: "a".repeat(80),
          applicationSessionExpiresAt: expiresAt,
        }),
        { status: 200 },
      ),
    );

    const response = await GET(
      new NextRequest(
        `https://infinitygram.co/auth/callback?grant=${"g".repeat(48)}`,
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/auth/complete");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("infinitygram-session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).not.toContain("Domain=");
  });

  it("rejects an old auth response that cannot establish a local session", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          returnTo: "https://infinitygram.co/",
        }),
        { status: 200 },
      ),
    );

    const response = await GET(
      new NextRequest(
        `https://infinitygram.co/auth/callback?grant=${"g".repeat(48)}`,
      ),
    );
    expect(response.headers.get("location")).toContain(
      "error=grant_exchange_failed",
    );
  });
});
