export type CatalogFailureStage =
  | "request"
  | "response_json"
  | "response_status"
  | "response_normalization";

const STAGES = new Set<CatalogFailureStage>([
  "request",
  "response_json",
  "response_status",
  "response_normalization",
]);
const NAMES = new Set(["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError"]);
const CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UND_ERR_RESPONSE_STATUS_CODE",
]);

type ErrorFields = { name?: unknown; code?: unknown; cause?: unknown; stack?: unknown };

/** Retain diagnostic frames/codes without response text, URLs, socket data, or credentials. */
export function redactCatalogCause(
  error: unknown,
  stage: CatalogFailureStage,
  seen = new Set<object>(),
): Error {
  const safe = new Error(`Catalog ${stage} failed`);
  try {
    if (!error || typeof error !== "object" || seen.has(error) || seen.size >= 4) return safe;
    seen.add(error);
    const fields = error as ErrorFields;
    if (typeof fields.name === "string" && NAMES.has(fields.name)) safe.name = fields.name;
    if (typeof fields.code === "string" && CODES.has(fields.code)) {
      Object.assign(safe, { code: fields.code });
      safe.message += ` (${fields.code})`;
    }
    if (error instanceof Error && typeof fields.stack === "string") {
      const frames = fields.stack
        .split("\n")
        .filter(
          (line) =>
            /^\s+at\s/.test(line) && /\((?:node:|\/|file:\/\/\/)[^?\n]+:\d+:\d+\)$/.test(line),
        )
        .slice(0, 20)
        .map((line) => line.slice(0, 500));
      safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join("\n");
    }
    if (
      fields.cause &&
      typeof fields.cause === "object" &&
      !seen.has(fields.cause) &&
      seen.size < 4
    )
      safe.cause = redactCatalogCause(fields.cause, stage, seen);
  } catch {
    // Diagnostics must not replace the catalog's original failure behavior.
  }
  return safe;
}

export function catalogFailureTags(error: unknown): Record<string, string> {
  const tags: Record<string, string> = {};
  try {
    if (!error || typeof error !== "object") return tags;
    const fields = error as {
      name?: unknown;
      failureStage?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    if (fields.name !== "PLPProductsError" && fields.name !== "PdpProductUnavailableError")
      return tags;
    if (
      typeof fields.failureStage === "string" &&
      STAGES.has(fields.failureStage as CatalogFailureStage)
    )
      tags.catalog_failure_stage = fields.failureStage;
    if (
      typeof fields.status === "number" &&
      Number.isInteger(fields.status) &&
      fields.status >= 100 &&
      fields.status <= 599
    )
      tags.catalog_http_status = String(fields.status);
    let cause = fields.cause;
    const seen = new Set<object>();
    while (cause && typeof cause === "object" && !seen.has(cause) && seen.size < 4) {
      seen.add(cause);
      const inner = cause as ErrorFields;
      if (typeof inner.code === "string" && CODES.has(inner.code))
        tags.catalog_cause_code = inner.code;
      if (typeof inner.name === "string" && NAMES.has(inner.name))
        tags.catalog_cause_type = inner.name;
      cause = inner.cause;
    }
  } catch {
    // Unusual error objects still propagate as actionable catalog failures.
  }
  return tags;
}
