import * as Sentry from "@sentry/nextjs";

import type * as SentryReplay from "./src/lib/sentry-replay";

import { isReplayAllowedUrl, replaySampleRate } from "./src/lib/sentry-replay-privacy";

const APP_INIT_MARK = "infinity:client-init";
const ROUTE_START_MARK = "infinity:route-transition-start";
const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const deploymentEnvironment = process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT || process.env.NODE_ENV;
const stagingReplay = deploymentEnvironment === "staging";
const replaySessionSampleRate = replaySampleRate(
  process.env.NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE,
  stagingReplay ? 1 : 0.01,
);
const replayErrorSampleRate = replaySampleRate(
  process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE,
  1,
);

/**
 * Replay (rrweb) is loaded on demand.
 *
 * Referencing `Sentry.replayIntegration` here would put rrweb in the chunk that
 * every storefront route parses before hydration, for a feature that records
 * nothing on most of them. `src/lib/sentry-replay.ts` owns the whole lifecycle
 * and is imported dynamically, after first paint, and only for routes the
 * privacy allowlist permits. Error and trace capture stay eager.
 */
let replayModule: Promise<typeof SentryReplay> | null = null;

function scheduleReplayRoute(url: string): void {
  if (!sentryDsn || typeof window === "undefined") {
    return;
  }

  // Nothing has been recorded yet, so a denied route has nothing to stop and
  // must not be the reason rrweb gets downloaded.
  if (!replayModule && !isReplayAllowedUrl(url)) {
    return;
  }

  replayModule ??= import("./src/lib/sentry-replay");
  void replayModule.then((module) => module.updateReplayRoute(url)).catch(() => undefined);
}

function whenIdle(run: () => void): void {
  if (typeof window === "undefined") {
    return;
  }

  const idle = (
    window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;

  if (typeof idle === "function") {
    // A timeout keeps the wait bounded: a PLP can stay busy long enough that an
    // unbounded idle callback would never run.
    idle(run, { timeout: 5_000 });
    return;
  }

  window.setTimeout(run, 1_500);
}

Sentry.init({
  dsn: sentryDsn,
  enabled: Boolean(sentryDsn),
  environment: deploymentEnvironment,
  tracesSampleRate: 0.1,
  // Replay is added only after the explicit public-route gate passes. This
  // prevents even a short sensitive-route capture during initialization.
  replaysSessionSampleRate: replaySessionSampleRate,
  replaysOnErrorSampleRate: replayErrorSampleRate,
  ignoreErrors: [
    // Android WebView's JavascriptInterface bridge can be garbage-collected
    // mid-call inside an in-app browser wrapper; this fires from the host
    // app's own injected bridge, not from any code in this repo.
    "Error invoking postMessage: Java object is gone",
    // Same story for iOS in-app browsers probing a `webkit.messageHandlers`
    // bridge this app never installs.
    /window\.webkit\.messageHandlers/,
    // Android/Instagram injects navigation and keyboard telemetry through a
    // Java bridge. Its callbacks can outlive the WebView object and are not
    // application failures.
    /Error invoking (?:enableDidUserTypeOnKeyboardLogging|postMessage): Java (?:object is gone|bridge method invocation error)/,
    // `new.infinitycolor.co` only 301s to the apex post-cutover; stale
    // service-worker registrations from before the cutover keep failing to
    // update there until each browser gives up and unregisters them.
    /Failed to update a ServiceWorker for scope \('https:\/\/new\.infinitycolor\.co\//,
    // Safari/WebKit quirk inside Next's vendored `web-vitals` package
    // (node_modules/next/dist/compiled/web-vitals): its flush-before-unload
    // path calls `observer.takeRecords()`, which some WebKit builds throw on.
    // Framework-internal, not something app code calls or can guard.
    /takeRecords is not a function/,
    // Sentry's Web Vitals integration asks for the visibility-state entry on
    // very old WebKit builds where Performance#getEntriesByType is absent.
    /globalThis\.performance\.getEntriesByType.*visibility-state/,
    // Android WebView / Instagram inject `getParams` into an eval frame
    // (`<anonymous>:1:1`). There is no storefront symbol by that name.
    /getParams is not defined/,
    // Safari injected-range helper, same anonymous eval pattern, not app code.
    /EmptyRanges/,
  ],
});

whenIdle(() => scheduleReplayRoute(typeof window === "undefined" ? "" : window.location.pathname));

try {
  performance.mark(APP_INIT_MARK);
} catch {
  // Performance marks are observational and must never block startup.
}

export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse",
) {
  scheduleReplayRoute(url);

  try {
    performance.mark(ROUTE_START_MARK, {
      detail: { navigationType },
    });
  } catch {
    // Unsupported mark detail or a restricted Performance API is non-fatal.
  }
}
