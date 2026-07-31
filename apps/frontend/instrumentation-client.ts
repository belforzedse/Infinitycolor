import * as Sentry from "@sentry/nextjs";

const APP_INIT_MARK = "infinity:client-init";
const ROUTE_START_MARK = "infinity:route-transition-start";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});

try {
  performance.mark(APP_INIT_MARK);
} catch {
  // Performance marks are observational and must never block startup.
}

export function onRouterTransitionStart(
  _url: string,
  navigationType: "push" | "replace" | "traverse",
) {
  try {
    performance.mark(ROUTE_START_MARK, {
      detail: { navigationType },
    });
  } catch {
    // Unsupported mark detail or a restricted Performance API is non-fatal.
  }
}
