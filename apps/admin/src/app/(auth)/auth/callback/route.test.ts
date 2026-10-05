/** @jest-environment node */
import { NextRequest } from "next/server";
import { GET } from "./route";
jest.mock("@/lib/central-auth-server", () => ({
  authServerOrigin: () => "http://auth.test",
  adminUrl: (path: string) => new URL(path, "https://admin.test"),
  validatedAdminReturnPath: (path: unknown) =>
    path === "/products" ? path : null,
}));
beforeEach(() => {
  global.fetch = jest.fn();
});
it.each([
  [400, "grant_exchange_failed"],
  [503, "grant_exchange_unavailable"],
])(
  "preserves attempt and no-cache redirects for HTTP %s without replaying the grant",
  async (status, reason) => {
    jest
      .mocked(fetch)
      .mockResolvedValue(new Response("{}", { status: Number(status) }));
    const req = new NextRequest(
      `https://admin.test/auth/callback?grant=${"g".repeat(48)}`,
    );
    req.cookies.set("infinity_admin_auth_restore_loop", "2");
    const result = await GET(req);
    const url = new URL(result.headers.get("location")!);
    expect(url.searchParams.get("attempt")).toBe("2");
    expect(url.searchParams.get("error")).toBe(reason);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it("keeps the deadline active through stalled grant-body parsing", async () => {
  jest.useFakeTimers();
  try {
    jest
      .mocked(fetch)
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      } as Response);
    const result = GET(
      new NextRequest(
        `https://admin.test/auth/callback?grant=${"g".repeat(48)}`,
      ),
    );
    await jest.advanceTimersByTimeAsync(5000);
    expect((await result).headers.get("location")).toContain(
      "grant_exchange_unavailable",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
it("retains the loop count on invalid grants without an exchange", async () => {
  const req = new NextRequest("https://admin.test/auth/callback?grant=bad");
  req.cookies.set("infinity_admin_auth_restore_loop", "2");
  const result = await GET(req);
  expect(
    new URL(result.headers.get("location")!).searchParams.get("attempt"),
  ).toBe("2");
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect(fetch).not.toHaveBeenCalled();
});
