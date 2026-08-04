import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT || "development",
  release: process.env.SENTRY_RELEASE || process.env.RELEASE_SHA || "development",
  sendDefaultPii: false,
  initialScope: { tags: { service: "infinity-admin" } },
  beforeSend(event) {
    event.user = undefined;
    if (event.request) {
      event.request.cookies = undefined;
      event.request.data = undefined;
      event.request.headers = undefined;
      if (event.request.url) {
        try {
          const url = new URL(event.request.url);
          url.search = "";
          event.request.url = url.toString().replace(/\/\d+(?=\/|$)/g, "/:id");
        } catch {
          event.request.url = undefined;
        }
      }
    }
    return event;
  },
});
