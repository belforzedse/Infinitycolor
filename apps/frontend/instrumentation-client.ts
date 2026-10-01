import { beforeSendDiagnosticLog } from "./src/lib/diagnostic-log";
import * as Sentry from "@sentry/nextjs";

import type * as SentryReplay from "./src/lib/sentry-replay";

import { isReplayAllowedUrl, replaySampleRate } from "./src/lib/sentry-replay-privacy";
import {
  dropExpectedCheckoutSentryEvent,
  EXPECTED_CHECKOUT_SENTRY_IGNORE,
} from "./src/lib/expected-checkout-sentry";
import {
  dropNoisyStorefrontSentryEvent,
  tagStorefrontSentryEvent,
} from "./src/lib/storefront-sentry-tags";

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
  enableLogs: true,
  beforeSendLog: beforeSendDiagnosticLog,
  tracesSampleRate: 0.1,
  // Replay is added only after the explicit public-route gate passes. This
  // prevents even a short sensitive-route capture during initialization.
  replaysSessionSampleRate: replaySessionSampleRate,
  replaysOnErrorSampleRate: replayErrorSampleRate,
  ignoreErrors: [
    // Safari/WebKit quirk inside Next's vendored `web-vitals` package
    // (node_modules/next/dist/compiled/web-vitals): its flush-before-unload
    // path calls `observer.takeRecords()`, which some WebKit builds throw on.
    // Framework-internal, not something app code calls or can guard.
    /takeRecords is not a function/,
    // Sentry's Web Vitals integration asks for the visibility-state entry on
    // very old WebKit builds where Performance#getEntriesByType is absent.
    /globalThis\.performance\.getEntriesByType.*visibility-state/,
    // Safari injected-range helper, same anonymous eval pattern, not app code.
    /EmptyRanges/,
    // wasm-bindgen / rrweb host panic; not storefront code.
    /recursive use of an object detected which would lead to unsafe aliasing in rust/,
    // Expected checkout leftovers. Also dropped in beforeSend so a stale
    // checkout chunk cannot keep reporting them after a frontend cutover.
    EXPECTED_CHECKOUT_SENTRY_IGNORE,
  ],
  beforeSend(event) {
    // Tag injects and Flight cuts, then drop the known-noise fingerprints.
    // WebView/Java-bridge strings that are not tagName/hydration stay visible.
    const tagged = tagStorefrontSentryEvent(event);
    const withoutNoise = dropNoisyStorefrontSentryEvent(tagged);
    if (!withoutNoise) return null;
    return dropExpectedCheckoutSentryEvent(withoutNoise);
  },
});

if (process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT === "staging" &&
    process.env.NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID && typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("sentry_probe") ===
      process.env.NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID) {
  void import("./src/lib/sentry-staging-probe")
    .then(({ runStagingSentryProbe }) => runStagingSentryProbe())
    .catch(() => undefined);
}

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
