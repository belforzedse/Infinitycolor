import { checkoutFailureDiagnostics } from "../checkout-error-diagnostics";
it("never infers network failure from arbitrary wording", () => {
  expect(checkoutFailureDiagnostics(new Error("network pricing mismatch"), "quote").errorCode).toBe(
    "UNKNOWN_ERROR",
  );
});
it("preserves sanitized operation and request correlation", () => {
  const result = checkoutFailureDiagnostics(
    {
      status: 408,
      message: "private body",
      diagnostics: { name: "AbortError", stage: "request", requestId: "req-123" },
    },
    "finalize",
  );
  expect(result).toMatchObject({
    errorCode: "REQUEST_TIMEOUT",
    attributes: { operation: "finalize", outcome: "timeout", request_id: "req-123" },
  });
  expect(JSON.stringify(result)).not.toContain("private");
});
it("keeps token acquisition failures distinct from confirmed logout", () => {
  expect(
    checkoutFailureDiagnostics({ name: "TokenAcquisitionError", status: 503 }, "finalize"),
  ).toMatchObject({ errorCode: "AUTH_RECOVERY_UNAVAILABLE" });
});

it("retains a sanitized original transport cause without private text", () => {
  const cause = Object.assign(new TypeError("API request failed"), { code: "UND_ERR_SOCKET" });
  const result = checkoutFailureDiagnostics(
    {
      message: "private endpoint",
      status: 500,
      cause,
      diagnostics: { stage: "request", name: "TypeError", code: "UND_ERR_SOCKET" },
    },
    "quote",
  );
  expect(result).toMatchObject({
    attributes: { operation: "quote", cause_code: "UND_ERR_SOCKET" },
    cause: { name: "TypeError", code: "UND_ERR_SOCKET" },
  });
  expect(JSON.stringify(result)).not.toContain("private endpoint");
});
