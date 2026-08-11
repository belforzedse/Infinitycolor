import * as Sentry from "@sentry/nextjs";

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

let replayIntegrationAdded = false;
let replayRouteActive = false;
let replayRecordingMode: "buffer" | "session" = "buffer";
let replayStopPromise: Promise<void> = Promise.resolve();

function currentReplayUrl(): string {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

function addReplayIntegration(): void {
  if (replayIntegrationAdded) {
    return;
  }

  Sentry.addIntegration(
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
      networkCaptureBodies: false,
      networkDetailAllowUrls: [],
      networkRequestHeaders: [],
      networkResponseHeaders: [],
      beforeErrorSampling: () => isReplayAllowedUrl(currentReplayUrl()),
    }),
  );
  replayIntegrationAdded = true;
}

function updateReplayRoute(url: string): void {
  if (!sentryDsn) {
    return;
  }

  const allowed = isReplayAllowedUrl(url);

  if (!allowed) {
    replayRouteActive = false;
    const replay = Sentry.getReplay();
    replayRecordingMode = replay?.getRecordingMode() ?? replayRecordingMode;
    replayStopPromise = replay?.stop().catch(() => undefined) ?? Promise.resolve();
    return;
  }

  if (replayRouteActive) {
    return;
  }

  if (!replayIntegrationAdded) {
    addReplayIntegration();
    const replay = Sentry.getReplay();
    replayRecordingMode = replay?.getRecordingMode() ?? replayRecordingMode;
    replayRouteActive = Boolean(replay);
    return;
  }

  const replay = Sentry.getReplay();
  if (!replay) {
    return;
  }

  replayRouteActive = true;
  void replayStopPromise.then(() => {
    if (!replayRouteActive) {
      return;
    }

    if (replayRecordingMode === "session") {
      replay.start();
    } else {
      replay.startBuffering();
    }
  });
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
});

updateReplayRoute(currentReplayUrl());

try {
  performance.mark(APP_INIT_MARK);
} catch {
  // Performance marks are observational and must never block startup.
}

export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse",
) {
  updateReplayRoute(url);

  try {
    performance.mark(ROUTE_START_MARK, {
      detail: { navigationType },
    });
  } catch {
    // Unsupported mark detail or a restricted Performance API is non-fatal.
  }
}
