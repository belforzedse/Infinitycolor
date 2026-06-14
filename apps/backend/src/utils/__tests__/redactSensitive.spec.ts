import { redactSensitive } from "../redactSensitive";

describe("redactSensitive", () => {
  it("redacts sensitive top-level keys", () => {
    const out = redactSensitive({ password: "hunter2", Status: "Started" });
    expect(out).toEqual({ password: "[redacted]", Status: "Started" });
  });

  it("matches keys case-insensitively and as substrings", () => {
    const out = redactSensitive({
      Authorization: "Bearer x",
      userPassword: "p",
      apiKey: "k",
      api_key: "k2",
      jwtToken: "t",
    });
    expect(out).toEqual({
      Authorization: "[redacted]",
      userPassword: "[redacted]",
      apiKey: "[redacted]",
      api_key: "[redacted]",
      jwtToken: "[redacted]",
    });
  });

  it("redacts nested objects and arrays", () => {
    const out = redactSensitive({
      meta: { secret: "s", note: "ok" },
      list: [{ token: "t", id: 1 }],
    });
    expect(out).toEqual({
      meta: { secret: "[redacted]", note: "ok" },
      list: [{ token: "[redacted]", id: 1 }],
    });
  });

  it("leaves non-sensitive data untouched", () => {
    const input = { Status: { from: "Paying", to: "Started" }, count: 3 };
    expect(redactSensitive(input)).toEqual(input);
  });

  it("returns non-object input unchanged", () => {
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive("x" as any)).toBe("x");
    expect(redactSensitive(5 as any)).toBe(5);
  });

  it("handles circular references safely", () => {
    const obj: any = { token: "t", self: null };
    obj.self = obj;
    const out = redactSensitive(obj);
    expect(out.token).toBe("[redacted]");
    expect(out.self).toBe("[circular]");
  });
});
