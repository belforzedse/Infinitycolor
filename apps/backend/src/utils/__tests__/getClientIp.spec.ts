import { getClientIp, getUserAgent, isPrivateIp } from "../getClientIp";

/** Build a minimal Koa-like context with the given headers (+ optional Koa-resolved ip/ips). */
const ctxWith = (
  headers: Record<string, string>,
  extra: { ip?: string; ips?: string[] } = {},
): any => ({
  request: {
    header: headers,
    headers,
    ip: extra.ip,
    ips: extra.ips,
  },
});

describe("getClientIp", () => {
  it("prefers cf-connecting-ip over everything", () => {
    const ctx = ctxWith({
      "cf-connecting-ip": "203.0.113.5",
      "x-real-ip": "198.51.100.7",
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    });
    expect(getClientIp(ctx)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip when no cf header", () => {
    const ctx = ctxWith({
      "x-real-ip": "198.51.100.7",
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    });
    expect(getClientIp(ctx)).toBe("198.51.100.7");
  });

  it("parses x-forwarded-for and picks the first public entry", () => {
    const ctx = ctxWith({ "x-forwarded-for": "10.0.0.1, 203.0.113.9, 172.16.0.4" });
    expect(getClientIp(ctx)).toBe("203.0.113.9");
  });

  it("returns the leftmost entry when every forwarded address is private", () => {
    const ctx = ctxWith({ "x-forwarded-for": "10.0.0.1, 172.16.0.4" });
    expect(getClientIp(ctx)).toBe("10.0.0.1");
  });

  it("normalizes IPv4-mapped IPv6 addresses", () => {
    const ctx = ctxWith({ "x-real-ip": "::ffff:203.0.113.9" });
    expect(getClientIp(ctx)).toBe("203.0.113.9");
  });

  it("falls back to Koa ctx.request.ip when no proxy headers are present", () => {
    const ctx = ctxWith({}, { ip: "203.0.113.50" });
    expect(getClientIp(ctx)).toBe("203.0.113.50");
  });

  it("prefers Koa ctx.request.ips[0] (proxy-aware) over raw ip", () => {
    const ctx = ctxWith({}, { ip: "172.26.0.1", ips: ["203.0.113.77", "172.26.0.1"] });
    expect(getClientIp(ctx)).toBe("203.0.113.77");
  });

  it("ignores garbage header values", () => {
    const ctx = ctxWith({ "x-real-ip": "not-an-ip" }, { ip: "203.0.113.9" });
    expect(getClientIp(ctx)).toBe("203.0.113.9");
  });

  it("returns null when nothing usable is available", () => {
    expect(getClientIp(ctxWith({}))).toBeNull();
    expect(getClientIp(null)).toBeNull();
    expect(getClientIp(undefined)).toBeNull();
  });
});

describe("getUserAgent", () => {
  it("reads the user-agent header", () => {
    expect(getUserAgent(ctxWith({ "user-agent": "jest-agent" }))).toBe("jest-agent");
  });

  it("returns null when absent", () => {
    expect(getUserAgent(ctxWith({}))).toBeNull();
    expect(getUserAgent(null)).toBeNull();
  });

  it("clips oversized headers to fit varchar(255) audit columns", () => {
    const oversized = "A".repeat(400);
    const result = getUserAgent(ctxWith({ "user-agent": oversized }));
    expect(result).toHaveLength(255);
    expect(result).toBe(oversized.slice(0, 255));
  });
});

describe("isPrivateIp", () => {
  it("flags private/loopback/link-local IPv4 ranges", () => {
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.26.0.1")).toBe(true); // Docker bridge gateway from the bug report
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.0.1")).toBe(true);
  });

  it("treats public IPv4 as public", () => {
    expect(isPrivateIp("203.0.113.9")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false); // outside the 172.16/12 block
  });

  it("flags private/loopback IPv6", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
  });
});
