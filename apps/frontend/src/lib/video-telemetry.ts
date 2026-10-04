"use client";

import * as Sentry from "@sentry/nextjs";
import type { StoryMediaIssue } from "@repo/story-rail";
import { setVideoTelemetrySink } from "@repo/video-player";
import { trackVideoPlayback } from "@/lib/analytics";
import { logDiagnostic, routeExpectedDiagnostic } from "./diagnostic-log";

/**
 * Where storefront playback telemetry goes: every view summary and error to the analytics
 * pipeline (Umami), and fatal failures to Sentry with their detail. Installed lazily by
 * the surfaces that play video, so pages without video pay nothing.
 */
let installed = false;

export function ensureVideoTelemetry(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  setVideoTelemetrySink((event) => {
    trackVideoPlayback(event);
    if (event.type === "error" && !event.fatal) {
      logDiagnostic(
        event.failure === "autoplay-denied" ? "video.autoplay_denied" : "video.recovery",
        {
          video_surface: event.surface,
          video_engine: event.engine,
          video_failure: event.failure,
          retry_count: Math.max(0, (event.attemptedEngines?.length ?? 1) - 1),
        },
      );
    }
    if (event.type === "error" && event.fatal && event.surface !== "story") {
      Sentry.captureMessage("video-playback-failure", {
        level: "warning",
        tags: {
          video_surface: event.surface,
          video_engine: event.engine,
          video_failure: event.failure,
        },
        extra: {
          detail: event.detail,
          host: event.host,
          path: event.path,
          browser: event.browser,
          device: event.device,
          attemptedEngines: event.attemptedEngines,
          playback: event.playback,
        },
      });
    }
  });
}

/**
 * Story failures, which used to go to a `globalThis.Sentry` nothing ever set — every
 * production report was dropped.
 */
export function reportStoryMediaIssue(issue: StoryMediaIssue): void {
  if (
    issue.failure === "autoplay-denied" &&
    routeExpectedDiagnostic("story.autoplay_denied", { media_type: issue.mediaType })
  )
    return;
  Sentry.captureMessage("story-media-failure", {
    // A refused autoplay is a browser policy (Low Power Mode, data saver), not a defect.
    level: issue.failure === "autoplay-denied" ? "info" : "warning",
    tags: { story_media_failure: issue.failure, story_media_type: issue.mediaType },
    extra: { ...issue },
  });
}
