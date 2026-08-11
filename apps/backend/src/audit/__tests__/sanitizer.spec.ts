import {
  normalizeAuditChanges,
  sanitizeAuditValue,
  sanitizeRequestIp,
  sanitizeUserAgent,
  serializeAuditJobContext,
} from "../sanitizer";

describe("audit payload sanitization", () => {
  it("redacts secret keys and secret-shaped values at every nested level", () => {
    const value = sanitizeAuditValue({
      password: "plain",
      nested: {
        accessToken: "secret-token",
        url: "https://example.test/callback?code=123456&safe=yes",
        authorizationText: "Bearer abc.def-123",
        jwtText: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
        cardText: "6037 9912 3456 7890",
      },
    });

    expect(value).toEqual({
      password: "[redacted]",
      nested: {
        accessToken: "[redacted]",
        url: "https://example.test/callback?code=[redacted]&safe=yes",
        authorizationText: "[redacted]",
        jwtText: "[redacted]",
        cardText: "[redacted]",
      },
    });
  });

  it("bounds depth, collections, strings, and total UTF-8 payload size", () => {
    const deep: any = {};
    let cursor = deep;
    for (let index = 0; index < 9; index += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    expect(JSON.stringify(sanitizeAuditValue(deep))).toContain("[max-depth]");
    expect((sanitizeAuditValue(Array.from({ length: 150 }, (_, index) => index)) as number[]))
      .toHaveLength(100);
    expect(String(sanitizeAuditValue("a".repeat(2_500)))).toContain("[truncated]");
    const oversized = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field${index}`, "ی".repeat(2_000)]),
    );
    expect(sanitizeAuditValue(oversized)).toMatchObject({
      truncated: true,
    });
  });

  it("never throws when a field-diff payload exceeds the aggregate limit", () => {
    expect(normalizeAuditChanges([
      { field: "description", from: "", to: "x".repeat(70_000) },
    ])).toEqual([
      expect.objectContaining({ field: "description" }),
    ]);
  });

  it("serializes only the minimal initiator and causal job context", () => {
    const serialized = serializeAuditJobContext({
      schemaVersion: 1,
      initiator: { type: "human", id: 42, label: "سارا محمدی", role: "Finance", roleId: 6 },
      origin: "admin_ui",
      requestId: "request-1",
      correlationId: "correlation-1",
      rootEventId: "9e0ebd30-513b-4c20-87c4-bde29ca268cb",
      causationId: "9e0ebd30-513b-4c20-87c4-bde29ca268cb",
      // Deliberately inject an unsupported property to prove it is not forwarded.
      actor: { type: "human", id: 42 },
    } as any);

    expect(serialized).toEqual({
      schemaVersion: 1,
      initiator: {
        type: "human",
        id: "42",
        label: "سارا محمدی",
        role: "Finance",
        roleId: "6",
      },
      origin: "admin_ui",
      requestId: "request-1",
      correlationId: "correlation-1",
      rootEventId: "9e0ebd30-513b-4c20-87c4-bde29ca268cb",
      causationId: "9e0ebd30-513b-4c20-87c4-bde29ca268cb",
    });
  });

  it("normalizes request origin values without accepting arbitrary header text", () => {
    expect(sanitizeRequestIp("203.0.113.5, 10.0.0.1")).toBe("203.0.113.5");
    expect(sanitizeRequestIp("not an ip")).toBeNull();
    expect(sanitizeUserAgent("Browser\u0000Bearer secret")).toBe("Browser [redacted]");
  });
});
