import * as Sentry from "@sentry/nextjs";

import { isReplayAllowedUrl } from "./sentry-replay-privacy";

/**
 * Session Replay lifecycle, deliberately isolated in its own module.
 *
 * `replayIntegration` and `getReplay` are what pull rrweb (~190-250 KB raw)
 * into whichever chunk references them. Keeping every replay symbol behind this
 * module boundary lets `instrumentation-client.ts` reach it with a dynamic
 * `import()`, so rrweb is fetched after load — and only on routes where the
 * privacy allowlist permits recording at all — instead of riding in the shared
 * storefront chunk that every route parses before hydration.
 *
 * The state machine below is the one that previously lived inline in
 * `instrumentation-client.ts`; behaviour on and after the first allowed route
 * is unchanged.
 */

let replayIntegrationAdded = false;
let replayRouteActive = false;
let replayRecordingMode: "buffer" | "session" = "buffer";
let replayStopPromise: Promise<void> = Promise.resolve();

function currentReplayUrl(): string {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

type ReplayRecordingEventLike = {
  data?: {
    tag?: unknown;
    payload?: {
      category?: unknown;
    };
  };
};

/**
 * Replay hydrate breadcrumbs become stackless "Hydration Error" issues on the
 * server. Drop the breadcrumb so a WebView/html-attr snapshot cannot mint one.
 * Real React #418 still arrives as an exception, not this breadcrumb category.
 */
export function dropHydrationReplayRecordingEvent<T>(event: T): T | null {
  if (!event || typeof event !== "object") return event;
  const category = (event as ReplayRecordingEventLike).data?.payload?.category;
  if (category === "replay.hydrate-error") return null;
  return event;
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
      beforeAddRecordingEvent: (event) => dropHydrationReplayRecordingEvent(event),
    }),
  );
  replayIntegrationAdded = true;
}

export function updateReplayRoute(url: string): void {
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
