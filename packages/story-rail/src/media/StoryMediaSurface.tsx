"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  initialPlaybackState,
  isHeld,
  isProgressRunning,
  playbackReducer,
  type MediaFailureKind,
  type PlaybackState,
} from "./playback-machine";
import { describeMediaUrl, useStoryPlaybackStore, type StoryPlaybackStore } from "./playback-store";
import { getSafeStoryCtaUrl } from "../story-utils";

/** Payload we attach to each package story item; the package passes it through untouched. */
export interface StoryMediaPayload {
  storyId: number;
  kind: "image" | "video" | "text";
  src: string;
  poster?: string;
  title: string;
  durationMs: number;
  text?: string;
  ctaUrl?: string | null;
}

/** Props the patched package hands a custom renderer (see patches/README.md, edit E3). */
export interface StoryMediaSurfaceProps {
  pause: () => void;
  resume: () => void;
  next: () => void;
  prev: () => void;
  setDuration: (ms: number) => void;
  item: { id: string; metadata?: unknown };
  isActive: boolean;
  isPaused: boolean;
}

/** A stall shorter than this is invisible; showing a spinner for it only adds flicker. */
const SPINNER_DELAY_MS = 400;
/** How long a video may claim to be playing with no decoded frames before we re-check. */
const DECODE_PROBE_MS = 600;
/** Two strikes before falling back: a wrong fallback replaces a playing video with a
 *  still, so it is worth one more frame's grace on a slow device. */
const DECODE_PROBE_ATTEMPTS = 2;
/** Progress is published to the viewer at this rate; the fill has a 0.1s CSS transition,
 *  so sampling faster only re-renders the whole viewer for nothing. */
const PROGRESS_PUBLISH_HZ = 15;

let generationCounter = 0;

function nextGeneration(): number {
  generationCounter += 1;
  return generationCounter;
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M11 5 6 9H2v6h4l5 4z" />
      {muted ? (
        <>
          <line x1="22" y1="9" x2="16" y2="15" />
          <line x1="16" y1="9" x2="22" y2="15" />
        </>
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}

function classifyMediaError(video: HTMLVideoElement): MediaFailureKind {
  // Numeric literals rather than the MediaError constants: jsdom does not expose that
  // global, and these codes are fixed by the HTML spec.
  switch (video.error?.code) {
    case 1:
      return "abort";
    case 2:
      return "network";
    case 3:
    case 4:
      return "decode-unsupported";
    default:
      return "unknown";
  }
}

/**
 * Chromium without platform HEVC support parses a `video/quicktime` HEVC file, reports
 * `readyState 4`, fires `playing`, advances `currentTime` — and decodes zero frames, with
 * no `error` event. The only observable signal is that the video track has no dimensions.
 * Production story media is exactly that shape, so this check is load-bearing, not defensive.
 */
function hasDecodableVideoTrack(video: HTMLVideoElement): boolean {
  if (video.videoWidth > 0 && video.videoHeight > 0) return true;
  const quality = video.getVideoPlaybackQuality?.();
  if (quality && quality.totalVideoFrames > 0) return true;
  return false;
}

export function StoryMediaSurface(props: StoryMediaSurfaceProps): React.ReactElement | null {
  const store = useStoryPlaybackStore();
  const [attempt, setAttempt] = useState(0);
  const payload = props.item?.metadata as StoryMediaPayload | undefined;

  // Reset the retry counter when the viewer moves to a different story.
  const lastItemIdRef = useRef(props.item?.id);
  if (lastItemIdRef.current !== props.item?.id) {
    lastItemIdRef.current = props.item?.id;
    if (attempt !== 0) setAttempt(0);
  }

  if (!payload) return null;

  // The package renders one stable component type at one position, so React would
  // otherwise reconcile across stories and mutate `src` on a live <video> element —
  // which aborts pending play promises and leaks the previous story's buffered data.
  // Keying here gives every story a genuinely fresh element and fresh state.
  return (
    <StoryMedia
      key={`${props.item.id}:${attempt}`}
      {...props}
      payload={payload}
      store={store}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

StoryMediaSurface.displayName = "StoryMediaSurface";

interface StoryMediaProps extends StoryMediaSurfaceProps {
  payload: StoryMediaPayload;
  store: StoryPlaybackStore | null;
  onRetry: () => void;
}

function StoryMedia({
  payload,
  store,
  onRetry,
  item,
  isActive,
  isPaused,
  next,
}: StoryMediaProps): React.ReactElement {
  const generation = useMemo(() => nextGeneration(), []);
  const [state, dispatch] = useReducer(playbackReducer, null, () =>
    initialPlaybackState(generation, payload.durationMs),
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stateRef = useRef<PlaybackState>(state);
  const nextRef = useRef(next);
  const [showSpinner, setShowSpinner] = useState(false);

  useLayoutEffect(() => {
    stateRef.current = state;
    nextRef.current = next;
  });

  const audioEnabled = useSyncExternalStore(
    store ? store.audio.subscribe : noopSubscribe,
    store ? store.audio.getSnapshot : returnFalse,
    returnFalse,
  );

  const isVideo = payload.kind === "video";
  // A video whose track never decoded is shown as its cover image instead.
  const showingVideoElement = isVideo && isActive && state.phase !== "fallback";

  const report = useCallback(
    (failure: MediaFailureKind, mediaErrorCode: number | null) => {
      if (!store) return;
      store.reportIssue({
        storyId: payload.storyId,
        mediaType: payload.kind,
        ...describeMediaUrl(payload.src),
        failure,
        mediaErrorCode,
      });
    },
    [store, payload.storyId, payload.kind, payload.src],
  );

  // ── Holds ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    dispatch({ type: "hold", hold: "user", value: isPaused });
  }, [isPaused]);

  useEffect(() => {
    dispatch({ type: "hold", hold: "inactive", value: !isActive });
  }, [isActive]);

  useEffect(() => {
    const sync = () => {
      dispatch({
        type: "hold",
        hold: "hidden",
        value: typeof document !== "undefined" && document.visibilityState !== "visible",
      });
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // ── Advance: exactly one owner, exactly once per story ───────────────────────
  const advancedRef = useRef(false);
  useEffect(() => {
    if (!state.advanceRequested || advancedRef.current) return;
    advancedRef.current = true;
    nextRef.current();
  }, [state.advanceRequested]);

  // ── Video element lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    if (!showingVideoElement) return;
    const video = videoRef.current;
    if (!video) return;

    let disposed = false;
    let decodeProbe: number | undefined;
    let retriedMuted = false;

    const held = () => isHeld(stateRef.current.holds);

    let decodeChecks = 0;
    const verifyDecodable = () => {
      if (disposed) return;
      if (hasDecodableVideoTrack(video)) return;
      // Only conclude "undecodable" once the pipeline has demonstrably run: currentTime
      // moving with zero frames is the signature of the Chromium HEVC case, whereas a
      // video that has not advanced at all is stalled, which the buffering path owns.
      if (video.currentTime < 0.2) {
        decodeProbe = window.setTimeout(verifyDecodable, DECODE_PROBE_MS);
        return;
      }
      decodeChecks += 1;
      if (decodeChecks < DECODE_PROBE_ATTEMPTS) {
        decodeProbe = window.setTimeout(verifyDecodable, DECODE_PROBE_MS);
        return;
      }
      // Nothing decoded. Without a cover image there is nothing to fall back to, so
      // surface it as an error the user can retry or navigate past.
      video.pause();
      if (payload.poster) {
        dispatch({
          type: "fallback",
          generation,
          durationMs: payload.durationMs,
        });
      } else {
        dispatch({ type: "failed", generation, failure: "decode-unsupported" });
      }
      report("decode-unsupported", video.error?.code ?? null);
    };

    const attemptPlay = () => {
      if (disposed || held()) return;
      const playPromise = video.play();
      if (!playPromise || typeof playPromise.catch !== "function") return;
      playPromise.catch((error: unknown) => {
        // Guarded by generation as well as `disposed`: a play() promise can settle after
        // the viewer has already moved on, and must not touch the new story's state.
        if (disposed || stateRef.current.generation !== generation) return;
        const name = (error as DOMException)?.name;
        if (name === "AbortError") {
          // pause()/remove during navigation — a lifecycle event, not a broken video.
          return;
        }
        if (name === "NotAllowedError") {
          if (!video.muted && !retriedMuted) {
            // Audible autoplay is refused until this tab has seen a gesture. Drop to
            // muted once; the mute control stays available for the user to opt back in.
            retriedMuted = true;
            video.muted = true;
            store?.audio.set(false);
            attemptPlay();
            return;
          }
          // Genuinely blocked. Stay out of `playing` — the UI must not pretend otherwise.
          report("autoplay-denied", null);
          return;
        }
        if (name === "NotSupportedError") {
          dispatch({
            type: "failed",
            generation,
            failure: "decode-unsupported",
          });
          report("decode-unsupported", video.error?.code ?? null);
          return;
        }
        dispatch({ type: "failed", generation, failure: "network" });
        report("network", video.error?.code ?? null);
      });
    };

    const onLoadedMetadata = () => {
      dispatch({
        type: "metadata",
        generation,
        durationMs: video.duration * 1000,
      });
    };
    const onReady = () => {
      dispatch({ type: "ready", generation });
      attemptPlay();
    };
    const onPlaying = () => {
      dispatch({ type: "playing", generation });
      window.clearTimeout(decodeProbe);
      decodeProbe = window.setTimeout(verifyDecodable, DECODE_PROBE_MS);
    };
    const onWaiting = () => dispatch({ type: "waiting", generation });
    const onEnded = () => {
      dispatch({ type: "ended", generation });
      dispatch({ type: "advance-requested", generation });
    };
    const onError = () => {
      const failure = classifyMediaError(video);
      if (failure === "abort") return;
      if (failure === "decode-unsupported" && payload.poster) {
        dispatch({
          type: "fallback",
          generation,
          durationMs: payload.durationMs,
        });
      } else {
        dispatch({ type: "failed", generation, failure });
      }
      report(failure, video.error?.code ?? null);
    };

    dispatch({ type: "loading", generation });
    // Set imperatively: React does not apply `muted` before first paint, which would
    // make the very first autoplay attempt an audible one and get it refused.
    video.muted = !(store?.audio.getSnapshot() ?? false);

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);

    // The element may already be past these by the time the effect runs.
    if (video.readyState >= 1) onLoadedMetadata();
    if (video.readyState >= 2) onReady();
    else attemptPlay();

    return () => {
      disposed = true;
      window.clearTimeout(decodeProbe);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
      // Silence first, then let React drop the element. No load()/removeAttribute("src")
      // here: those abort outstanding operations and are unnecessary when the element is
      // being unmounted anyway.
      video.muted = true;
      video.pause();
    };
    // `payload.poster`/`durationMs`/`src` are fixed for this mount (the surface remounts
    // per story), so this effect runs exactly once per media element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingVideoElement, generation]);

  // ── Follow holds: only the live, unheld story may play ───────────────────────
  const held = isHeld(state.holds);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !showingVideoElement) return;
    if (held) {
      video.pause();
      return;
    }
    if (state.phase === "ready" || state.phase === "buffering" || state.phase === "playing") {
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          // Resume failures are handled by the element's own error/autoplay paths; a
          // rejected resume must not be reported twice or flip the UI into "playing".
        });
      }
    }
  }, [held, showingVideoElement, state.phase]);

  // ── Sound preference ─────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !showingVideoElement) return;
    video.muted = !audioEnabled;
  }, [audioEnabled, showingVideoElement]);

  // ── Progress ─────────────────────────────────────────────────────────────────
  const running = isProgressRunning(state);
  const usesMediaClock = showingVideoElement && state.phase === "playing";

  // Throttled publish of the value the clock just produced — not a ref sampled on a
  // separate interval, which always trails the last committed render by a frame.
  const lastPublishRef = useRef(0);
  const publish = useCallback(
    (value: number) => {
      if (!store || !isActive) return;
      const now = performance.now();
      if (now - lastPublishRef.current < 1000 / PROGRESS_PUBLISH_HZ) return;
      lastPublishRef.current = now;
      store.publishProgress(item.id, value);
    },
    [store, isActive, item.id],
  );

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    // Wall clock for images, text and the poster fallback. Videos use currentTime, which
    // is the only progress that cannot run ahead of what the viewer is actually seeing.
    let startedAt = performance.now();
    let elapsed = stateRef.current.progress * stateRef.current.durationMs;

    const tick = () => {
      const duration = stateRef.current.durationMs;
      if (duration > 0) {
        let raw: number;
        if (usesMediaClock && videoRef.current) {
          raw = (videoRef.current.currentTime * 1000) / duration;
        } else {
          elapsed += performance.now() - startedAt;
          startedAt = performance.now();
          raw = elapsed / duration;
        }
        // Clamp before publishing: a clock that overshoots (a seek, a duration revised
        // downwards) would otherwise render the bar as scaleX(>1).
        const value = Math.min(Math.max(raw, 0), 1);
        dispatch({ type: "progress", generation, value });
        publish(value);
        if (value >= 1 && !usesMediaClock) {
          dispatch({ type: "advance-requested", generation });
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, usesMediaClock, generation, publish]);

  // Mirror phase transitions only — mount at 0, `ended` at 1, the fallback restart. The
  // running clock publishes its own samples, throttled; depending on `state.progress`
  // here would republish on every committed frame and undo that throttle, re-rendering
  // the whole viewer at animation rate.
  useEffect(() => {
    if (!store || !isActive) return;
    store.publishProgress(item.id, stateRef.current.progress);
  }, [store, isActive, item.id, state.phase]);

  // ── Spinner only for perceptible stalls ──────────────────────────────────────
  const stalled =
    state.phase === "loading" || state.phase === "buffering" || state.phase === "idle";
  useEffect(() => {
    if (!stalled || !isActive) {
      setShowSpinner(false);
      return;
    }
    const id = window.setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [stalled, isActive]);

  // ── Image / text readiness ───────────────────────────────────────────────────
  const onImageLoad = useCallback(() => {
    dispatch({ type: "ready", generation });
    dispatch({ type: "playing", generation });
  }, [generation]);

  const onImageError = useCallback(() => {
    dispatch({ type: "failed", generation, failure: "network" });
    report("network", null);
  }, [generation, report]);

  useEffect(() => {
    if (payload.kind !== "text") return;
    dispatch({ type: "ready", generation });
    dispatch({ type: "playing", generation });
  }, [payload.kind, generation]);

  const toggleAudio = useCallback(
    (event: React.SyntheticEvent) => {
      // The viewer navigates on taps anywhere over the surface, so the control has to
      // keep its own tap from reaching it.
      event.stopPropagation();
      event.preventDefault();
      if (!store) return;
      const enabled = !store.audio.getSnapshot();
      store.audio.set(enabled);
      const video = videoRef.current;
      if (!video) return;
      video.muted = !enabled;
      if (enabled) {
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {
            // Unmuting is a user gesture, so this should not be refused; if it is, the
            // element stays where it was rather than claiming to play.
          });
        }
      }
    },
    [store],
  );

  const stopTap = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  const posterUrl = payload.kind === "video" ? payload.poster : undefined;
  const showPoster = Boolean(posterUrl) && (state.phase === "fallback" || !state.hasPresented);
  const ctaUrl = getSafeStoryCtaUrl(payload.ctaUrl);
  const opensNewTab = Boolean(ctaUrl && /^https?:\/\//i.test(ctaUrl));

  return (
    <div
      data-testid="story-media-surface"
      // Exposed for tests and for debugging a live viewer: the playback phase and who is
      // holding it are the two things you need to explain any Stories misbehaviour.
      data-phase={state.phase}
      data-held={held ? "true" : "false"}
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black"
    >
      {posterUrl ? (
        <img
          src={posterUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain"
          style={{ opacity: showPoster ? 1 : 0 }}
        />
      ) : null}

      {payload.kind === "image" ? (
        <img
          src={payload.src}
          alt={payload.title}
          draggable={false}
          onLoad={onImageLoad}
          onError={onImageError}
          className="relative h-full w-full object-cover"
          style={{ opacity: state.hasPresented ? 1 : 0 }}
        />
      ) : null}

      {payload.kind === "text" ? (
        <div className="relative flex h-full w-full items-center justify-center bg-[#111827] px-10 text-center text-[28px] font-semibold leading-snug text-white">
          {payload.text || payload.title}
        </div>
      ) : null}

      {showingVideoElement ? (
        <video
          ref={videoRef}
          src={payload.src}
          poster={posterUrl}
          className="relative h-full w-full object-contain"
          playsInline
          preload="auto"
          controls={false}
          disablePictureInPicture
          controlsList="nodownload noplaybackrate noremoteplayback"
          style={{ opacity: state.hasPresented ? 1 : 0 }}
        />
      ) : null}

      {ctaUrl && state.phase !== "error" ? (
        <a
          href={ctaUrl}
          target={opensNewTab ? "_blank" : undefined}
          rel={opensNewTab ? "noopener noreferrer" : undefined}
          onClick={stopTap}
          onPointerDown={stopTap}
          onPointerUp={stopTap}
          onMouseDown={stopTap}
          onMouseUp={stopTap}
          onTouchStart={stopTap}
          onTouchEnd={stopTap}
          data-testid="story-cta"
          className="absolute bottom-6 left-1/2 z-20 inline-flex min-h-11 min-w-40 max-w-[calc(100%_-_7rem)] -translate-x-1/2 items-center justify-center rounded-full bg-white px-6 py-2.5 text-center font-peyda text-sm font-semibold text-[#424242] shadow-lg transition-colors hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        >
          مشاهده لینک
        </a>
      ) : null}

      {isVideo && isActive && state.phase !== "error" ? (
        <button
          type="button"
          onClick={toggleAudio}
          onPointerDown={stopTap}
          onPointerUp={stopTap}
          onMouseDown={stopTap}
          onMouseUp={stopTap}
          onTouchStart={stopTap}
          onTouchEnd={stopTap}
          aria-label={audioEnabled ? "قطع صدا" : "پخش صدا"}
          aria-pressed={audioEnabled}
          className={`absolute right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${ctaUrl ? "bottom-20" : "bottom-6"}`}
        >
          <SpeakerIcon muted={!audioEnabled} />
        </button>
      ) : null}

      {showSpinner ? (
        <div
          data-testid="story-media-spinner"
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20"
        >
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/35 border-t-white" />
        </div>
      ) : null}

      {state.phase === "error" ? (
        <div
          data-testid="story-media-error"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/70 px-8 text-center"
        >
          <p className="font-peyda text-base leading-7 text-white">
            این استوری در این مرورگر پخش نمی‌شود.
          </p>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              event.preventDefault();
              onRetry();
            }}
            onPointerDown={stopTap}
            onPointerUp={stopTap}
            className="rounded-full border border-white/70 px-5 py-2 font-peyda text-sm text-white transition-colors hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          >
            تلاش دوباره
          </button>
        </div>
      ) : null}
    </div>
  );
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function returnFalse(): boolean {
  return false;
}

export default StoryMediaSurface;
