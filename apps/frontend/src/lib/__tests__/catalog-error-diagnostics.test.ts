import { catalogFailureTags, redactCatalogCause } from "../catalog-error-diagnostics";

it("bounds cyclic causes and keeps only known cause codes/types and local diagnostic frames", () => {
  const source = Object.assign(new TypeError("private customer response"), {
    code: "ECONNREFUSED",
  });
  source.cause = source;
  source.stack =
    "TypeError: private customer response\n    at load (/app/.next/server/plp.js:10:2)\n    at fetch (https://user:password@host/path?token=secret:1:2)";
  const safe = redactCatalogCause(source, "request");
  expect(safe.stack).toContain("/app/.next/server/plp.js:10:2");
  expect(safe.stack).not.toMatch(/private|password|token|https/);
  expect(() => JSON.stringify(safe)).not.toThrow();
  expect(
    catalogFailureTags({ name: "PLPProductsError", cause: safe, failureStage: "request" }),
  ).toEqual({
    catalog_failure_stage: "request",
    catalog_cause_type: "TypeError",
    catalog_cause_code: "ECONNREFUSED",
  });
});

it("does not copy arbitrary error data, raw response content, or cause messages into tags", () => {
  const cause = Object.assign(new Error("email=customer@example.test"), { code: "private_code" });
  const safe = redactCatalogCause(cause, "response_json");
  expect(String(safe)).toBe("Error: Catalog response_json failed");
  expect(
    catalogFailureTags({
      name: "PLPProductsError",
      failureStage: "private_stage",
      status: 999,
      cause: safe,
    }),
  ).toEqual({ catalog_cause_type: "Error" });
  expect(catalogFailureTags({ name: "OtherError", cause })).toEqual({});
});

it("keeps diagnostics harmless when an error field getter throws", () => {
  const error = {
    get cause() {
      throw new Error("unavailable");
    },
  };
  expect(() => redactCatalogCause(error, "request")).not.toThrow();
  expect(catalogFailureTags({ name: "PLPProductsError", cause: error })).toEqual({});
});
