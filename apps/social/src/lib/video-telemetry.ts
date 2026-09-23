"use client";

import type { StoryMediaIssue } from "@repo/story-rail";
import { setVideoTelemetrySink, type VideoTelemetryEvent } from "@repo/video-player";

/**
 * Social (Infinitygram) playback telemetry, sent to the same self-hosted Umami the
 * storefront uses. Only video events are sent: no pageviews, no identify, no user data.
 * The tracker is loaded lazily the first time a video surface reports something, with its
 * host and website id read at runtime from /api/telemetry-config; when that is unset the
 * whole thing stays off and nothing is loaded.
 */

type UmamiApi = { track: (name: string, data?: Record<string, unknown>) => void };
type State = "idle" | "loading" | "ready" | "off";

const MAX_QUEUED = 50;
const queue: Array<[string, Record<string, unknown>]> = [];
let state: State = "idle";
let installed = false;

function umami(): UmamiApi | undefined {
  return (window as unknown as { umami?: UmamiApi }).umami;
}

function flush(): void {
  const api = umami();
  if (!api) return;
  while (queue.length) {
    const [name, data] = queue.shift()!;
    try {
      api.track(name, data);
    } catch {
      // Telemetry never affects the page.
    }
  }
}

async function loadTracker(): Promise<void> {
  if (state !== "idle") return;
  state = "loading";
  try {
    const response = await fetch("/api/telemetry-config", { credentials: "omit" });
    const config = (await response.json()) as { umamiUrl: string | null; websiteId: string | null };
    if (!config.umamiUrl || !config.websiteId) {
      state = "off";
      queue.length = 0;
      return;
    }
    const script = document.createElement("script");
    script.src = `${config.umamiUrl}/telemetry.js`;
    script.defer = true;
    script.dataset.websiteId = config.websiteId;
    script.dataset.hostUrl = config.umamiUrl;
    script.dataset.autoPageview = "false";
    script.dataset.autoTrack = "false";
    script.onload = () => {
      state = "ready";
      flush();
    };
    script.onerror = () => {
      state = "off";
      queue.length = 0;
    };
    document.head.appendChild(script);
  } catch {
    state = "off";
    queue.length = 0;
  }
}

function send(name: string, data: Record<string, unknown>): void {
  if (state === "off") return;
  if (state === "ready" && umami()) {
    try {
      umami()!.track(name, data);
    } catch {
      // ignore
    }
    return;
  }
  if (queue.length < MAX_QUEUED) queue.push([name, data]);
  void loadTracker();
}

function toEvent(event: VideoTelemetryEvent): [string, Record<string, unknown>] {
  if (event.type === "summary") {
    return [
      "video_playback",
      {
        surface: event.surface,
        engine: event.engine,
        fell_back: event.fellBack,
        startup_ms: event.startupMs ?? undefined,
        startup_failed: event.startupFailed,
        rebuffer_count: event.rebufferCount,
        rebuffer_ms: event.rebufferMs,
        watched_ms: event.watchedMs,
        start_height: event.startHeight ?? undefined,
        max_height: event.maxHeight ?? undefined,
        level_switches: event.levelSwitches,
        video_failure: event.failure ?? undefined,
        browser: event.browser,
        device: event.device,
        media_host: event.host,
      },
    ];
  }
  return [
    "video_playback_error",
    {
      surface: event.surface,
      engine: event.engine,
      video_failure: event.failure,
      detail: event.detail.replace(/\s+/g, "_").slice(0, 120),
      fatal: event.fatal,
      browser: event.browser,
      device: event.device,
      media_host: event.host,
    },
  ];
}

export function ensureVideoTelemetry(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  setVideoTelemetrySink((event) => {
    const [name, data] = toEvent(event);
    send(name, data);
  });
}

/** Story failures (previously dropped: they went to a global `Sentry` social never had). */
export function reportStoryMediaIssue(issue: StoryMediaIssue): void {
  send("story_media_issue", {
    video_failure: issue.failure,
    media_type: issue.mediaType,
    media_host: issue.mediaHost,
    media_error_code: issue.mediaErrorCode ?? undefined,
  });
}
