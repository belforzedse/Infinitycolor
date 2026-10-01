import * as Sentry from "@sentry/nextjs";
import { logDiagnostic } from "./diagnostic-log";

function captureStagingSourceMapProbe(probeId: string): void {
  const error = new Error("Infinitycolor staging source-map verification");
  error.name = "StagingSourceMapProbeError";
  Sentry.captureException(error, {
    level: "info",
    fingerprint: ["staging-source-map-probe"],
    tags: { diagnostic_event: "diagnostics.probe", area: "browser", reasonCode: probeId },
  });
}

/** Loaded only by an explicitly enabled staging build; never affects rendering. */
export function runStagingSentryProbe(): boolean {
  try {
    const probeId = process.env.NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID;
    if (
      process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT !== "staging" ||
      typeof window === "undefined" ||
      !probeId ||
      !/^[a-zA-Z0-9_-]{8,64}$/.test(probeId) ||
      !Sentry.isEnabled()
    )
      return false;
    const requested = new URLSearchParams(window.location.search).getAll("sentry_probe");
    if (requested.length !== 1 || requested[0] !== probeId) return false;
    const key = `infinity:sentry-probe:${probeId}`;
    if (window.sessionStorage.getItem(key)) return false;
    // Fail closed when storage is unavailable: a refresh must not flood telemetry.
    window.sessionStorage.setItem(key, "1");
    if (
      !logDiagnostic("diagnostics.probe", {
        area: "browser",
        stage: "browser",
        reasonCode: probeId,
      })
    )
      return false;
    captureStagingSourceMapProbe(probeId);
    return true;
  } catch {
    return false;
  }
}
