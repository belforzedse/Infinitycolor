import { logDiagnostic } from "./diagnostic-log";
import { getProcessRole } from "./processRole";

let emitted = false;

/** No domain reads, jobs, or Issue events; only a labelled staging startup Log. */
export function emitStagingStartupProbe(env: NodeJS.ProcessEnv = process.env): boolean {
  const probeId = env.SENTRY_DIAGNOSTICS_PROBE_ID;
  if (
    emitted ||
    env.SENTRY_ENVIRONMENT !== "staging" ||
    !probeId ||
    !/^[a-zA-Z0-9_-]{8,64}$/.test(probeId)
  )
    return false;
  const role = getProcessRole(env);
  if (role === "cli") return false;
  const area =
    role === "web"
      ? "api"
      : role === "worker" && env.WORKER_QUEUES === "media"
        ? "media-worker"
        : role;
  emitted = logDiagnostic("diagnostics.probe", { area, stage: "startup", reasonCode: probeId });
  return emitted;
}
