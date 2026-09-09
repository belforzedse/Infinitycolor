/** @jest-environment node */

import { NextRequest } from "next/server";
import { GET } from "./route";

describe("Infinitygram application token broker", () => {
  beforeEach(() => {
    process.env.AUTH_SERVER_ORIGIN = "https://auth.infinitycolor.co";
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("exchanges the host-only application cookie for a short-lived JWT", async () => {
    const token = "header.payload.signature";
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ token }), { status: 200 }),
      );
    const request = new NextRequest("https://infinitygram.co/api/auth/token", {
      headers: {
        cookie: `infinitygram-session=${"c".repeat(80)}`,
        "sec-fetch-site": "same-origin",
      },
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ token });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/infinity/application-token"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("https://infinitygram.co"),
      }),
    );
  });

  it("clears a rejected application session", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
      }),
    );
    const request = new NextRequest("https://infinitygram.co/api/auth/token", {
      headers: {
        cookie: `infinitygram-session=${"c".repeat(80)}`,
        "sec-fetch-site": "same-origin",
      },
    });

    const response = await GET(request);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain(
      "infinitygram-session=",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
