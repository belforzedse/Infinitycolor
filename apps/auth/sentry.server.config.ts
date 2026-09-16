import * as Sentry from "@sentry/nextjs";

// Strips cookies/body/headers/query string; auth events must carry no phone, OTP, password, or session data.
function scrubEvent(event: Sentry.Event): Sentry.Event {
  event.user = undefined;
  if (event.request) {
    event.request.cookies = undefined;
    event.request.data = undefined;
    event.request.headers = undefined;
    if (event.request.url) {
      try {
        const url = new URL(event.request.url);
        url.search = "";
        event.request.url = url.toString();
      } catch {
        event.request.url = undefined;
      }
    }
  }
  return event;
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.AUTH_DEPLOYMENT_ENV || process.env.NODE_ENV,
  sendDefaultPii: false,
  tracesSampleRate: 0,
  initialScope: { tags: { service: "infinity-auth" } },
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
});
