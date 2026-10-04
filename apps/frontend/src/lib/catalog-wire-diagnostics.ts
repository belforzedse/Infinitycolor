import { channel } from "node:diagnostics_channel";
import { getStrapiServerUrl } from "@/constants/api";
import { logDiagnostic } from "./diagnostic-log";

const TRACE_HEADERS = new Set(["sentry-trace", "baggage", "traceparent", "tracestate"]);

/** Numbers only. Raw values are neither retained nor passed to telemetry. */
export function catalogWireShape(path: string, headers: string) {
  let application = 0;
  let trace = 0;
  // The first line is the request line, not an application header.
  for (const line of headers.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const size = Buffer.byteLength(line + "\r\n");
    if (TRACE_HEADERS.has(line.slice(0, colon).toLowerCase())) trace += size;
    else application += size;
  }
  return {
    request_target_bytes: Buffer.byteLength(path),
    application_header_bytes: application,
    trace_header_bytes: trace,
    wire_header_bytes: Buffer.byteLength(headers),
  };
}

let installed = false;
/** Observe exact transmitted headers. Never patch fetch or modify a request. */
export function installCatalogWireDiagnostics(): () => void {
  if (installed) return () => undefined;
  const base = new URL(getStrapiServerUrl());
  const receipts = new WeakMap<object, ReturnType<typeof catalogWireShape>>();
  let windowAt = Date.now();
  let emitted = 0;
  const sent = (message: unknown) => {
    try {
      const item = message as {
        request: { method?: string; origin?: unknown; path?: string };
        headers?: unknown;
      };
      const request = item.request;
      if (
        request?.method !== "GET" ||
        String(request.origin) !== base.origin ||
        !request.path?.startsWith(`${base.pathname.replace(/\/$/, "")}/products`) ||
        typeof item.headers !== "string"
      )
        return;
      receipts.set(request, catalogWireShape(request.path, item.headers));
    } catch {
      /* Diagnostic-channel callbacks must never throw into Undici. */
    }
  };
  const received = (message: unknown) => {
    try {
      const item = message as {
        request: object;
        response?: { statusCode?: number; headers?: Buffer[] };
      };
      const shape = receipts.get(item.request);
      receipts.delete(item.request);
      const status = item.response?.statusCode;
      if (!shape || !status || status < 400) return;
      if (Date.now() - windowAt >= 60_000) {
        windowAt = Date.now();
        emitted = 0;
      }
      if (++emitted > 20) return;
      let requestId: string | undefined;
      const headers = item.response?.headers;
      if (Array.isArray(headers))
        for (let index = 0; index + 1 < Math.min(headers.length, 128); index += 2) {
          if (String(headers[index]).toLowerCase() !== "x-request-id") continue;
          const value = String(headers[index + 1]);
          if (/^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) requestId = value;
          break;
        }
      logDiagnostic("catalog.recovery", {
        ...shape,
        request_id: requestId,
        operation: "catalog_wire",
        failure_stage: "response_status",
        http_status: status,
        outcome: "failed",
      });
    } catch {
      /* Reporting cannot change the request outcome. */
    }
  };
  const sending = channel("undici:client:sendHeaders");
  const responses = channel("undici:request:headers");
  sending.subscribe(sent);
  responses.subscribe(received);
  installed = true;
  return () => {
    sending.unsubscribe(sent);
    responses.unsubscribe(received);
    installed = false;
  };
}
