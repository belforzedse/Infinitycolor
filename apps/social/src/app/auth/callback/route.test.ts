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
      "error=grant_exchange_unavailable",
    );
  });
});

it.each([
  [400, "grant_exchange_failed"],
  [503, "grant_exchange_unavailable"],
])(
  "preserves attempt and no-cache on HTTP %s without replaying grants",
  async (status, reason) => {
    process.env.AUTH_SERVER_ORIGIN = "https://auth.infinitycolor.co";
    const exchange = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: Number(status) }));
    try {
      const req = new NextRequest(
        `https://infinitygram.co/auth/callback?grant=${"g".repeat(48)}`,
      );
      req.cookies.set("infinity_auth_restore_loop", "2");
      const result = await GET(req);
      const url = new URL(result.headers.get("location")!);
      expect(url.searchParams.get("attempt")).toBe("2");
      expect(url.searchParams.get("error")).toBe(reason);
      expect(result.headers.get("cache-control")).toContain("no-store");
      expect(exchange).toHaveBeenCalledTimes(1);
    } finally {
      exchange.mockRestore();
    }
  },
);
