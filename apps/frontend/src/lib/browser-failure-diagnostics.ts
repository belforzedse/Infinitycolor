/** Bounded diagnostics only. No rejection text, query strings, headers, or customer data. */
type ResourceFailure = {
  kind: "script" | "style" | "rejection";
  chunk?: string;
  rejection_type?: string;
};
const failures: ResourceFailure[] = [];
const handlers: Record<string, number> = {};
let installed = false;
const TYPES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "AbortError",
  "NetworkError",
  "TimeoutError",
]);

export function recordBrowserHandler(
  handler: "search_route" | "search_dismiss" | "header_scroll" | "scroll_update" | "visibility",
): void {
  handlers[handler] = Math.min(64, (handlers[handler] ?? 0) + 1);
}

function chunkPath(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value, window.location.origin);
    if (/^\/_next\/static\/[a-zA-Z0-9_./-]{1,220}\.(?:js|css)$/.test(url.pathname))
      return url.pathname;
  } catch {
    /* Unknown resources remain unclassified. */
  }
}

export function installBrowserFailureDiagnostics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const append = (entry: ResourceFailure) => {
    failures.push(entry);
    if (failures.length > 8) failures.shift();
  };
  try {
    window.addEventListener(
      "error",
      (event) => {
        try {
          const target = event.target;
          if (target instanceof HTMLScriptElement)
            append({ kind: "script", chunk: chunkPath(target.src) });
          else if (target instanceof HTMLLinkElement)
            append({ kind: "style", chunk: chunkPath(target.href) });
        } catch {
          /* Observation cannot replace the original error. */
        }
      },
      true,
    );
    window.addEventListener("unhandledrejection", (event) => {
      try {
        const name =
          event.reason && typeof event.reason === "object" ? event.reason.name : undefined;
        append({ kind: "rejection", rejection_type: TYPES.has(name) ? name : typeof event.reason });
      } catch {
        append({ kind: "rejection", rejection_type: "unknown" });
      }
    });
  } catch {
    /* Exact injection recovery is separate; unknown registration failures aren't hidden by filtering. */
  }
}

export function browserFailureSnapshot(): Record<string, unknown> {
  let resources: Array<Record<string, unknown>> = [];
  try {
    resources = performance
      .getEntriesByType("resource")
      .slice(-32)
      .flatMap((entry) => {
        const chunk = chunkPath(entry.name);
        if (!chunk) return [];
        const timing = entry as PerformanceResourceTiming;
        return [
          {
            chunk,
            transfer_bytes: timing.transferSize,
            encoded_bytes: timing.encodedBodySize,
            decoded_bytes: timing.decodedBodySize,
            duration_ms: Math.round(timing.duration),
          },
        ];
      })
      .slice(-8);
  } catch {
    /* Missing old browser APIs do not break reporting. */
  }
  return {
    failures: failures.map((entry) => ({ ...entry })),
    resources,
    handlers: { ...handlers },
    ready_state: typeof document === "undefined" ? "unknown" : document.readyState,
    visibility: typeof document === "undefined" ? "unknown" : document.visibilityState,
  };
}
