import * as Sentry from "@sentry/nextjs";
import { beforeSendDiagnosticLog } from "./src/lib/diagnostic-log";
import { applyCatalogRscEvent } from "./src/lib/sentry-catalog-rsc";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT || process.env.NODE_ENV,
  enableLogs: true,
  beforeSendLog: beforeSendDiagnosticLog,
  tracesSampleRate: 0.1,
  beforeSend(event, hint) {
    return applyCatalogRscEvent(event, hint);
  },
});
