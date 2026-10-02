import { redactCatalogCause } from "./catalog-error-diagnostics";

export type CheckoutOperation = "stock_check" | "quote" | "finalize" | "handoff";
const CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const NAMES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "AbortError",
  "NetworkError",
  "TimeoutError",
  "TokenAcquisitionError",
]);

export function checkoutFailureDiagnostics(error: unknown, operation: CheckoutOperation) {
  const item =
    error && typeof error === "object"
      ? (error as {
          name?: string;
          reasonCode?: string;
          cause?: unknown;
          status?: number;
          requestId?: string;
          diagnostics?: {
            name?: string;
            code?: string;
            stage?: string;
            requestId?: string;
            cancelled?: boolean;
          };
        })
      : {};
  const name = item.diagnostics?.name ?? item.name;
  const code = item.diagnostics?.code;
  const status =
    typeof item.status === "number" && item.status >= 0 && item.status <= 599
      ? item.status
      : undefined;
  const requestId = item.diagnostics?.requestId ?? item.requestId;
  const reason =
    item.name === "TokenAcquisitionError"
      ? "auth_unavailable"
      : item.diagnostics?.cancelled
        ? "cancelled"
        : status === 408 || name === "TimeoutError"
          ? "timeout"
          : name === "NetworkError" || (code && CODES.has(code))
            ? "network"
            : "unknown";
  const attributes = {
    operation,
    outcome: reason,
    http_status: status,
    cause_code: code && CODES.has(code) ? code : undefined,
    cause_type: name && NAMES.has(name) ? name : undefined,
    failure_stage: ["request", "response_json", "response_status"].includes(
      item.diagnostics?.stage ?? "",
    )
      ? item.diagnostics?.stage
      : undefined,
    request_id: requestId && /^[a-zA-Z0-9_.:-]{1,100}$/.test(requestId) ? requestId : undefined,
  };
  return {
    attributes,
    errorCode:
      reason === "network"
        ? "NETWORK_ERROR"
        : reason === "timeout"
          ? "REQUEST_TIMEOUT"
          : reason === "auth_unavailable"
            ? "AUTH_RECOVERY_UNAVAILABLE"
            : "UNKNOWN_ERROR",
    cause: redactCatalogCause(item.cause ?? error, "request"),
  };
}
