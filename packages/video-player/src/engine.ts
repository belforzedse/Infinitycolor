/// <reference path="./hls-light.d.ts" />
import type Hls from "hls.js";
import type { ErrorData } from "hls.js";
import {
  canPlayWebm,
  chooseEngine,
  openHlsCircuit,
  type PlaybackEngine,
} from "./capabilities";
import type { VideoSource } from "./delivery";
import {
  DECODE_PROBE_ATTEMPTS,
  DECODE_PROBE_MS,
  hasDecodableVideoTrack,
  watchFirstFrame,
} from "./frames";
import {
  buildHlsConfig,
  levelCapForPlayer,
  readBandwidthEstimate,
  recordBandwidthEstimate,
} from "./hls-config";
import {
  emitVideoTelemetry,
  PlaybackSession,
  type VideoFailureKind,
  type PlaybackDiagnostics,
  type NativePlayRecord,
} from "./telemetry";

/**
 * The single low-level playback layer: one engine per `<video>` element per source.
 *
 * It owns everything that is the same on every surface — choosing HLS or MP4, creating
 * and destroying hls.js, recovering from its errors or falling back to the MP4, noticing
 * the first presented frame, detecting "plays but decodes nothing", timing the view, and
 * releasing the element. Surfaces (stories, product gallery, post carousel) keep their own
 * UX: when to play, progress, holds, posters, error copy.
 *
 * Element events (`playing`, `waiting`, `ended`, …) are still the surface's to observe;
 * the engine never swallows them. Element `error` events, however, are the engine's:
 * during an HLS→MP4 fallback the element reports errors that are already being handled,
 * so surfaces act on `onFatal` instead.
 */

export type EngineFailure = Exclude<
  VideoFailureKind,
  "autoplay-denied" | "hls-fallback" | "webm-fallback"
>;
export type PlayOutcome = "playing" | "autoplay-denied" | "aborted" | "failed";

export interface VideoEngineOptions {
  /** Telemetry label: `story`, `pdp`, `post-detail`, … */
  surface: string;
  /** HLS is opt-in per surface; stories stay on the progressive MP4. */
  allowHls?: boolean;
  preload?: "none" | "metadata" | "auto";
  onFirstFrame?: () => void;
  /** Playback cannot continue on any path. Called at most once. */
  onFatal?: (failure: EngineFailure, detail: string) => void;
  onEngineChange?: (engine: PlaybackEngine) => void;
}

export interface NativePlayAttempt {
  readonly sourceGeneration: number;
  readonly attempt: number;
  isCurrent(): boolean;
}

export interface VideoEngine {
  readonly engine: PlaybackEngine;
  readonly diagnostics: PlaybackDiagnostics;
  readonly hasFirstFrame: boolean;
  /** Attaches the source. Idempotent. */
  load(): void;
  /**
   * `video.play()` with the autoplay policy handled: an audible attempt the browser
   * refuses is retried muted when `mutedFallback` is set.
   */
  play(options?: { mutedFallback?: boolean }): Promise<PlayOutcome>;
  /** For surfaces that call `video.play()` themselves: starts the startup clock. */
  markPlayRequested(): NativePlayAttempt;
  /** Records only results owned by the current source and uncancelled play request. */
  settleNativePlay(attempt: NativePlayAttempt, error?: unknown): boolean;
  cancelPlay(reason: "hold" | "pause"): void;
  /** Lets a surface with its own play-policy UX recover a NotSupportedError. */
  recoverDecodeFailure(): boolean;
  /** Pauses, tears down hls.js, releases the element's resource. Idempotent. */
  dispose(): void;
}

let liveEngines = 0;
let liveHlsInstances = 0;

/** For tests and debugging: engines/hls.js instances not yet disposed. */
export function liveEngineCounts(): { engines: number; hls: number } {
  return { engines: liveEngines, hls: liveHlsInstances };
}

let hlsLoader: Promise<typeof Hls> | null = null;

/** Starts downloading hls.js ahead of the first HLS playback on a page. */
export function preloadHls(): Promise<typeof Hls> {
  hlsLoader ??= import("hls.js/light")
    .then((module) => module.default)
    .catch((error) => {
      hlsLoader = null;
      throw error;
    });
  return hlsLoader;
}

const MANIFEST_DETAILS = new Set([
  "manifestLoadError",
  "manifestLoadTimeOut",
  "manifestParsingError",
  "manifestIncompatibleCodecsError",
  "levelLoadError",
  "levelLoadTimeOut",
  "levelEmptyError",
]);

export function createVideoEngine(
  video: HTMLVideoElement,
  source: VideoSource,
  options: VideoEngineOptions,
): VideoEngine {
  let engine = chooseEngine(source, {
    allowHls: options.allowHls ?? false,
    video,
  });
  const session = new PlaybackSession(
    options.surface,
    engine,
    engine === "webm"
      ? source.webm!
      : engine === "mp4"
        ? source.mp4
        : source.hls!,
  );
  let hls: Hls | null = null;
  let loaded = false;
  let disposed = false;
  let firstFrame = false;
  let fatal = false;
  let playIntent = false;
  let sourceVersion = 0;
  let playAttempt = 0;
  let cancellationVersion = 0;
  let rejectionType: string | undefined;
  const attemptHistory: NativePlayRecord[] = [];
  const diagnostics = (): PlaybackDiagnostics => ({
    ...session.diagnostics,
    sourceGeneration: sourceVersion,
    rejectionType,
    mediaReadyState: video.readyState,
    mediaNetworkState: video.networkState,
    attemptHistory: attemptHistory.map((entry) => ({ ...entry })),
  });
  const markPlayRequested = (): NativePlayAttempt => {
    playIntent = true;
    session.requested();
    const version = sourceVersion;
    const attempt = ++playAttempt;
    const cancellation = cancellationVersion;
    attemptHistory.push({
      sourceGeneration: version,
      attempt,
      engine,
      outcome: "requested",
    });
    if (attemptHistory.length > 8) attemptHistory.shift();
    return {
      sourceGeneration: version,
      attempt,
      isCurrent: () =>
        !disposed &&
        playIntent &&
        version === sourceVersion &&
        cancellation === cancellationVersion,
    };
  };
  const settleNativePlay = (
    attempt: NativePlayAttempt,
    error?: unknown,
  ): boolean => {
    if (!attempt.isCurrent()) return false;
    const name = (error as { name?: string } | undefined)?.name;
    rejectionType = error
      ? ["NotAllowedError", "NotSupportedError", "AbortError"].includes(
          name ?? "",
        )
        ? name
        : "unknown"
      : undefined;
    const record = attemptHistory.find(
      (entry) => entry.attempt === attempt.attempt,
    );
    if (record)
      record.outcome = (rejectionType ??
        "playing") as NativePlayRecord["outcome"];
    return true;
  };
  let mp4NetworkRetries = 0;
  let webmAttempted = engine === "webm";
  let webmFallback = false;
  let webmRecovered = false;
  let hlsNetworkRestarts = 0;
  let lastMediaRecovery = -Infinity;
  let decodeTimer: ReturnType<typeof setTimeout> | undefined;
  let decodeChecks = 0;
  let cancelFrameWatch: () => void = () => undefined;
  const listeners: Array<[string, EventListener]> = [];
  // Resolves once the element has a source. hls.js attaches asynchronously (dynamic import,
  // then MediaSource), and a play() issued before that is aborted by the browser the moment
  // hls.js sets `src` — silently losing autoplay. play() waits on this instead.
  let isAttached = false;
  let resolveAttached: () => void = () => undefined;
  const attached = new Promise<void>((resolve) => {
    resolveAttached = resolve;
  });
  const markAttached = () => {
    isAttached = true;
    resolveAttached();
  };

  liveEngines += 1;

  const on = (type: string, handler: EventListener) => {
    video.addEventListener(type, handler);
    listeners.push([type, handler]);
  };

  const reportFatal = (failure: EngineFailure, detail: string) => {
    if (disposed || fatal) return;
    fatal = true;
    emitVideoTelemetry({
      ...session.error(failure, detail, true),
      playback: diagnostics(),
    });
    options.onFatal?.(failure, detail);
  };

  const startFrameWatch = () => {
    cancelFrameWatch();
    cancelFrameWatch = watchFirstFrame(video, () => {
      if (disposed) return;
      if (engine === "webm" && webmFallback && !webmRecovered) {
        webmRecovered = true;
        emitVideoTelemetry(
          session.error("webm-fallback", "first frame", false),
        );
      }
      if (firstFrame) return;
      firstFrame = true;
      session.firstFrame();
      options.onFirstFrame?.();
    });
  };

  const verifyDecodable = () => {
    if (disposed) return;
    if (hasDecodableVideoTrack(video)) return;
    // Only conclude "undecodable" once the pipeline has demonstrably run: time moving
    // with zero frames is the Chromium-without-HEVC signature; not moving is a stall,
    // which the buffering path owns.
    if (video.currentTime < 0.2) {
      decodeTimer = setTimeout(verifyDecodable, DECODE_PROBE_MS);
      return;
    }
    decodeChecks += 1;
    if (decodeChecks < DECODE_PROBE_ATTEMPTS) {
      decodeTimer = setTimeout(verifyDecodable, DECODE_PROBE_MS);
      return;
    }
    video.pause();
    if (fallBackToWebm()) return;
    reportFatal("decode-unsupported", "no decoded frames");
  };

  const attachProgressive = (startAt = 0) => {
    sourceVersion += 1;
    clearTimeout(decodeTimer);
    decodeChecks = 0;
    const rate = video.playbackRate;
    video.src = engine === "webm" ? source.webm! : source.mp4;
    markAttached();
    // load() resets the playback rate to defaultPlaybackRate in browser media engines.
    // Restore user controls and the seek only for the currently attached source.
    const version = sourceVersion;
    const restore = () => {
      video.removeEventListener("loadedmetadata", restore);
      if (disposed || version !== sourceVersion) return;
      video.playbackRate = rate;
      if (startAt > 0.1) {
        try {
          video.currentTime = startAt;
        } catch {
          /* Older WebKit may reject an early seek. */
        }
      }
    };
    on("loadedmetadata", restore);
    video.load();
    video.playbackRate = rate;
  };

  const destroyHls = () => {
    if (!hls) return;
    try {
      hls.destroy();
    } catch {
      // ignore
    }
    hls = null;
    liveHlsInstances -= 1;
  };

  const resumeIfWanted = () => {
    if (!playIntent || disposed) return;
    const version = sourceVersion;
    const resume = () => {
      if (disposed || !playIntent || version !== sourceVersion) return;
      const attempt = markPlayRequested();
      void video.play().then(
        () => {
          settleNativePlay(attempt);
        },
        (error: unknown) => {
          if (!settleNativePlay(attempt, error)) return;
          const name = (error as DOMException | undefined)?.name;
          if (name === "NotSupportedError" && !fallBackToWebm())
            reportFatal("decode-unsupported", "NotSupportedError after resume");
          else if (name === "NotAllowedError")
            emitVideoTelemetry(
              session.error(
                "autoplay-denied",
                "NotAllowedError after resume",
                false,
              ),
            );
          else if (name !== "NotSupportedError")
            reportFatal("unknown", "play rejected after resume");
        },
      );
    };
    const once = () => {
      video.removeEventListener("canplay", once);
      resume();
    };
    on("canplay", once);
  };

  const fallBackToWebm = (): boolean => {
    if (
      disposed ||
      fatal ||
      engine !== "mp4" ||
      webmAttempted ||
      !source.webm ||
      !canPlayWebm(video, source.hasAudio)
    )
      return false;
    webmAttempted = true;
    webmFallback = true;
    const position = video.currentTime;
    engine = "webm";
    mp4NetworkRetries = 0;
    session.setEngine(engine, true, source.webm!);
    options.onEngineChange?.(engine);
    attachProgressive(position);
    startFrameWatch();
    resumeIfWanted();
    return true;
  };

  const fallBackToMp4 = (reason: string) => {
    if (disposed || engine === "mp4" || engine === "webm") return;
    const position = video.currentTime;
    destroyHls();
    engine = "mp4";
    session.setEngine(engine, true, source.mp4);
    emitVideoTelemetry(session.error("hls-fallback", reason, false));
    options.onEngineChange?.(engine);
    attachProgressive(position);
    resumeIfWanted();
  };

  /**
   * Fetch the master playlist before creating hls.js. The failures that actually happen —
   * CORS missing on the media host, a stale or missing playlist — then fall back to the MP4
   * without the element ever touching MediaSource or hls.js being constructed, and hls.js's
   * own request for the same immutable playlist is then served from the HTTP cache.
   */
  const preflightPlaylist = async (): Promise<boolean> => {
    try {
      const response = await fetch(source.hls!, {
        mode: "cors",
        credentials: "omit",
      });
      if (response.ok) return true;
      fallBackToMp4(`manifest ${response.status}`);
      return false;
    } catch {
      // No response at all: CORS, offline, blocked. Every playlist on this origin will fail
      // the same way, so HLS is off for the rest of the session.
      openHlsCircuit();
      fallBackToMp4("manifest 0");
      return false;
    }
  };

  const onHlsError = (HlsClass: typeof Hls, data: ErrorData) => {
    if (disposed || !data.fatal || !hls) return;
    if (data.type === HlsClass.ErrorTypes.NETWORK_ERROR) {
      if (MANIFEST_DETAILS.has(data.details)) {
        const status = data.response?.code ?? 0;
        // Status 0 = the request never produced a response (CORS, offline, blocked):
        // every playlist on this origin will fail alike, so stop trying HLS this session.
        if (status === 0) openHlsCircuit();
        fallBackToMp4(`manifest ${status}`);
        return;
      }
      if (hlsNetworkRestarts < 1) {
        hlsNetworkRestarts += 1;
        hls.startLoad();
        return;
      }
      fallBackToMp4(`network ${data.details}`);
      return;
    }
    if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR) {
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      // One recovery per 5 s window; a second media error that soon means recovery is not
      // helping and the MP4 is the better bet.
      if (now - lastMediaRecovery > 5_000) {
        lastMediaRecovery = now;
        hls.recoverMediaError();
        return;
      }
      fallBackToMp4(`media ${data.details}`);
      return;
    }
    fallBackToMp4(`other ${data.details}`);
  };

  const attachHlsJs = async () => {
    let HlsClass: typeof Hls;
    try {
      HlsClass = await preloadHls();
    } catch {
      fallBackToMp4("hls.js failed to load");
      return;
    }
    if (disposed) return;
    if (!HlsClass.isSupported()) {
      fallBackToMp4("hls.js unsupported");
      return;
    }
    if (!(await preflightPlaylist()) || disposed) return;
    const instance = new HlsClass(buildHlsConfig(readBandwidthEstimate()));
    hls = instance;
    liveHlsInstances += 1;
    instance.on(HlsClass.Events.ERROR, (_event, data) =>
      onHlsError(HlsClass, data),
    );
    instance.on(HlsClass.Events.LEVEL_SWITCHED, (_event, data) => {
      session.level(instance.levels[data.level]?.height);
    });
    instance.on(HlsClass.Events.FRAG_LOADED, () => {
      recordBandwidthEstimate(instance.bandwidthEstimate);
    });
    instance.on(HlsClass.Events.MEDIA_ATTACHED, () => markAttached());
    // `autoStartLoad` is off: cap the ladder to this element before the first level is
    // chosen, then start.
    instance.on(HlsClass.Events.MANIFEST_PARSED, () => {
      if (disposed || hls !== instance) return;
      const box = video.getBoundingClientRect();
      const pixelRatio =
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const cap = levelCapForPlayer(instance.levels, box, pixelRatio);
      if (cap >= 0) instance.autoLevelCapping = cap;
      instance.startLoad();
    });
    instance.attachMedia(video);
    instance.loadSource(source.hls!);
  };

  const onElementError = () => {
    if (disposed) return;
    // Under hls.js the element error is a symptom; hls.js reports the cause.
    if (engine === "hls.js") return;
    const code = video.error?.code ?? 0;
    if (code === 1) {
      reportFatal("unknown", "media abort without cancellation context");
      return;
    }
    if (engine === "native-hls") {
      fallBackToMp4(`native hls error ${code}`);
      return;
    }
    if (code === 2 && mp4NetworkRetries < 1) {
      mp4NetworkRetries += 1;
      attachProgressive(video.currentTime);
      resumeIfWanted();
      return;
    }
    if ((code === 3 || code === 4) && fallBackToWebm()) return;
    reportFatal(
      code === 3 || code === 4
        ? "decode-unsupported"
        : code === 2
          ? "network"
          : "unknown",
      `media error ${code}`,
    );
  };

  on("error", onElementError);
  on("playing", () => {
    session.playing();
    clearTimeout(decodeTimer);
    decodeTimer = setTimeout(verifyDecodable, DECODE_PROBE_MS);
  });
  on("waiting", () => session.waiting());
  on("pause", () => session.paused());
  on("ended", () => session.paused());

  return {
    get diagnostics() {
      return diagnostics();
    },
    get engine() {
      return engine;
    },
    get hasFirstFrame() {
      return firstFrame;
    },
    load() {
      if (loaded || disposed) return;
      loaded = true;
      video.preload = options.preload ?? "metadata";
      startFrameWatch();
      if (engine === "hls.js") {
        void attachHlsJs();
      } else if (engine === "native-hls") {
        video.src = source.hls!;
        markAttached();
        video.load();
      } else if (
        video.getAttribute("src") ===
        (engine === "webm" ? source.webm : source.mp4)
      ) {
        // The owner rendered the MP4 declaratively, so the browser has been fetching it
        // since the element was created — for a lazily revealed viewer that is during the
        // render React holds back before the reveal, a few hundred ms before any effect
        // runs. Adopt it: re-assigning and reloading would restart that head start.
        markAttached();
        if (video.error) onElementError();
      } else {
        attachProgressive();
      }
    },
    markPlayRequested,
    settleNativePlay,
    cancelPlay(reason) {
      playIntent = false;
      cancellationVersion += 1;
      const record = attemptHistory[attemptHistory.length - 1];
      if (record?.outcome === "requested") {
        record.outcome = "cancelled";
        record.cancellationContext = reason;
      }
    },
    recoverDecodeFailure: fallBackToWebm,
    async play({ mutedFallback = true } = {}) {
      if (disposed) return "aborted";
      let attempt = markPlayRequested();
      const cancellation = cancellationVersion;
      // Only wait while hls.js is still attaching: with a source already in place, play()
      // must run synchronously so a tap's user activation (WebKit) still covers it.
      if (!isAttached) {
        await attached;
        if (disposed || !playIntent || cancellation !== cancellationVersion)
          return "aborted";
        // An initial HLS preflight may choose MP4 before anything was attached.
        // Ownership starts at that first source, while logout/pause/disposal still cancels intent.
        if (attempt.sourceGeneration !== sourceVersion)
          attempt = markPlayRequested();
      }
      try {
        await video.play();
        return settleNativePlay(attempt) ? "playing" : "aborted";
      } catch (error) {
        if (!settleNativePlay(attempt, error)) return "aborted";
        const name = (error as DOMException | undefined)?.name;
        if (name === "NotAllowedError") {
          if (!video.muted && mutedFallback) {
            video.muted = true;
            try {
              await video.play();
              return settleNativePlay(attempt) ? "playing" : "aborted";
            } catch (retryError) {
              if (!settleNativePlay(attempt, retryError)) return "aborted";
              if (
                (retryError as DOMException | undefined)?.name !==
                "NotAllowedError"
              ) {
                reportFatal("unknown", "muted play rejected");
                return "failed";
              }
            }
          }
          emitVideoTelemetry(
            session.error("autoplay-denied", "NotAllowedError", false),
          );
          return "autoplay-denied";
        }
        if (name === "NotSupportedError") {
          if (fallBackToWebm()) return "aborted";
          reportFatal("decode-unsupported", "NotSupportedError");
        } else reportFatal("unknown", "play rejected");
        return "failed";
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      playIntent = false;
      markAttached();
      liveEngines -= 1;
      cancelFrameWatch();
      clearTimeout(decodeTimer);
      for (const [type, handler] of listeners)
        video.removeEventListener(type, handler);
      const summary = session.finish();
      if (summary) emitVideoTelemetry(summary);
      try {
        video.pause();
      } catch {
        // ignore
      }
      destroyHls();
      // Release the decoder and any in-flight range request now rather than at garbage
      // collection: WebKit keeps downloading for an element that is merely detached.
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // ignore
      }
    },
  };
}
