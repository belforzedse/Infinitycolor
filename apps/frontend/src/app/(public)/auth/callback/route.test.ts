/** @jest-environment node */
import { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { GET } from "./route";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("@/lib/central-auth-server", () => ({
  authServerOrigin: () => "http://auth.test",
  storefrontUrl: (path: string) => new URL(path, "https://store.test"),
  validatedStorefrontReturnPath: (path: unknown) => (path === "/account" ? path : null),
}));
const request = () => new NextRequest(`https://store.test/auth/callback?grant=${"a".repeat(48)}`);
beforeEach(() => {
  global.fetch = jest.fn();
  jest.clearAllMocks();
});
it("exchanges a grant once and returns a non-cacheable redirect", async () => {
  jest
    .mocked(fetch)
    .mockResolvedValue(new Response(JSON.stringify({ authenticated: true, returnTo: "/account" })));
  const result = await GET(request());
  expect(result.headers.get("location")).toContain("/auth/complete?returnTo=%2Faccount");
  expect(result.headers.get("cache-control")).toBe("no-store, max-age=0");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(Sentry.captureException).not.toHaveBeenCalled();
});
it("reports an ambiguous transport failure once without replaying the grant", async () => {
  jest.mocked(fetch).mockRejectedValue(new DOMException("aborted", "AbortError"));
  const result = await GET(request());
  expect(result.headers.get("location")).toContain("error=grant_exchange_unavailable");
  expect(result.headers.get("cache-control")).toBe("no-store, max-age=0");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(jest.mocked(Sentry.captureException).mock.calls)).not.toContain(
    "a".repeat(48),
  );
});
it.each([
  [503, "grant_exchange_unavailable"],
  [401, "grant_exchange_failed"],
])("distinguishes HTTP %s", async (status, reason) => {
  jest.mocked(fetch).mockResolvedValue(new Response("{}", { status: Number(status) }));
  const result = await GET(request());
  expect(result.headers.get("location")).toContain(`error=${reason}`);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
});

it.each(["not JSON", "{}"])(
  "treats malformed successful exchange payloads as unavailable",
  async (body) => {
    jest.mocked(fetch).mockResolvedValue(new Response(body));
    const result = await GET(request());
    expect(result.headers.get("location")).toContain("error=grant_exchange_unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  },
);

it("keeps the deadline active through body parsing without replaying the grant", async () => {
  jest.useFakeTimers();
  try {
    jest
      .mocked(fetch)
      .mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response);
    const result = GET(request());
    await jest.advanceTimersByTimeAsync(5_000);
    expect((await result).headers.get("location")).toContain("error=grant_exchange_unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it.each(["invalid", "rejected", "unavailable"])(
  "propagates the existing attempt through %s redirects",
  async (kind) => {
    const req =
      kind === "invalid"
        ? new NextRequest("https://store.test/auth/callback?grant=bad")
        : request();
    req.cookies.set("infinity_auth_restore_loop", "2");
    jest
      .mocked(fetch)
      .mockResolvedValue(new Response("{}", { status: kind === "rejected" ? 400 : 503 }));
    const result = await GET(req);
    expect(new URL(result.headers.get("location")!).searchParams.get("attempt")).toBe("2");
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(fetch).toHaveBeenCalledTimes(kind === "invalid" ? 0 : 1);
  },
);
it("does not report a successful recovery attempt as a restore loop", async () => {
  const req = request();
  req.cookies.set("infinity_auth_restore_loop", "1");
  jest
    .mocked(fetch)
    .mockResolvedValue(new Response(JSON.stringify({ authenticated: true, returnTo: "/account" })));
  expect(new URL((await GET(req)).headers.get("location")!).searchParams.get("attempt")).toBe("1");
  expect(Sentry.captureException).not.toHaveBeenCalled();
});
