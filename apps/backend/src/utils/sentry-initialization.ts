import * as Sentry from "@sentry/node";
import { beforeSendDiagnosticLog } from "./diagnostic-log";
import { emitStagingStartupProbe } from "./sentry-staging-probe";
import { redactEditProofs } from "./redact-edit-proofs";

let initialized = false;

/** The scheduler does not load Strapi's entrypoint; every process shares this setup. */
export function initializeBackendSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (initialized) return true;
  try {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      enabled: !!env.SENTRY_DSN,
      environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
      release: env.SENTRY_RELEASE || env.RELEASE_SHA,
      enableLogs: true,
      beforeSendLog: beforeSendDiagnosticLog,
      beforeSend: redactEditProofs,
      beforeSendTransaction: redactEditProofs,
    });
    initialized = true;
    emitStagingStartupProbe(env);
    return true;
  } catch {
    // Observability must not prevent any process from starting.
    return false;
  }
}
