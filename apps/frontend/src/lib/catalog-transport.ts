import { logDiagnostic } from "./diagnostic-log";
import { redactCatalogCause, type CatalogFailureStage } from "./catalog-error-diagnostics";

const RETRY_STATUSES = new Set([502, 503, 504]);
const CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export class CatalogTransportError extends Error {
  constructor(
    public readonly failureStage: CatalogFailureStage,
    cause: unknown,
    public readonly status?: number,
    public readonly requestId?: string,
    public readonly attempts = 1,
    public readonly knownCancellation = false,
  ) {
    super("Catalog transport failed", { cause: redactCatalogCause(cause, failureStage) });
    this.name = "CatalogTransportError";
  }
}

function connectionFailure(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  while (current && typeof current === "object" && !seen.has(current) && seen.size < 4) {
    seen.add(current);
    const item = current as { code?: string; cause?: unknown; name?: string; message?: string };
    if (item.code && CONNECTION_CODES.has(item.code)) return true;
    if (
      item.name === "TypeError" &&
      ["fetch failed", "Failed to fetch", "Load failed"].includes(item.message ?? "")
    )
      return true;
    current = item.cause;
  }
  return false;
}

/** Catalog GETs only. The deadline includes headers, body and the single retry. */
export async function fetchCatalogJson<T>(
  input: string,
  init: RequestInit = {},
  operation = "catalog",
  budget?: { deadlineAt: number },
): Promise<{ response: Response; data: T; requestId?: string; attempts: number }> {
  if (init.method && init.method.toUpperCase() !== "GET")
    throw new Error("Catalog transport only supports GET");
  const started = Date.now();
  const deadline = Math.min(started + 15_000, budget?.deadlineAt ?? Infinity);
  if (started >= deadline)
    throw new CatalogTransportError(
      "request",
      Object.assign(new Error("Catalog deadline exceeded"), {
        name: "TimeoutError",
        code: "ETIMEDOUT",
      }),
    );
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    let response: Response | undefined;
    let requestId: string | undefined;
    let stage: CatalogFailureStage = "request";
    const cancel = () => controller.abort();
    const timeout = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(1, Math.min(10_000, deadline - Date.now())),
    );
    if (init.signal?.aborted) cancel();
    else init.signal?.addEventListener("abort", cancel, { once: true });
    let rejectAbort: ((error: Error) => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort?.(
        Object.assign(new Error("Catalog request interrupted"), {
          name: timedOut ? "TimeoutError" : "AbortError",
          code: timedOut ? "ETIMEDOUT" : "ABORT_ERR",
        }),
      );
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    try {
      const work = async () => {
        response = await fetch(input, { ...init, method: "GET", signal: controller.signal });
        const candidate = response.headers?.get("x-request-id");
        if (candidate && /^[a-zA-Z0-9_.:-]{1,100}$/.test(candidate)) requestId = candidate;
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { response, data: undefined as T, requestId, attempts: attempt };
        }
        stage = "response_json";
        const data = (await response.json()) as T;
        return { response, data, requestId, attempts: attempt };
      };
      const result = await Promise.race([work(), interrupted]);
      if (
        RETRY_STATUSES.has(result.response.status) &&
        attempt === 1 &&
        Date.now() < deadline &&
        !init.signal?.aborted
      )
        continue;
      if (attempt > 1 || !result.response.ok)
        logDiagnostic("catalog.recovery", {
          operation,
          outcome: result.response.ok ? "recovered" : "failed",
          http_status: result.response.status,
          retry_count: attempt - 1,
          duration_ms: Date.now() - started,
          request_id: requestId,
        });
      return result;
    } catch (cause) {
      const cancelled = Boolean(init.signal?.aborted);
      if (!cancelled && attempt === 1 && Date.now() < deadline && connectionFailure(cause))
        continue;
      const error = new CatalogTransportError(
        stage,
        cause,
        response?.status,
        requestId,
        attempt,
        cancelled,
      );
      logDiagnostic("catalog.recovery", {
        operation,
        outcome: cancelled ? "cancelled" : "exhausted",
        failure_stage: stage,
        cause_code: (error.cause as { code?: string })?.code,
        http_status: response?.status,
        retry_count: attempt - 1,
        duration_ms: Date.now() - started,
        request_id: requestId,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }
  throw new Error("Catalog attempts exhausted");
}
