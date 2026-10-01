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
import type { StoryRailOverlay } from "../types";
import { createVideoEngine, chooseEngine, type VideoSource } from "@repo/video-player";

/** Payload we attach to each package story item; the package passes it through untouched. */
export interface StoryMediaPayload {
  storyId: number;
  itemKey: string;
  kind: "image" | "video" | "text";
  src: string;
  poster?: string;
  /** Media-worker delivery for video items (resolved URLs); absent for legacy media. */
  video?: VideoSource;
  title: string;
  durationMs: number;
  text?: string;
  ctaUrl?: string | null;
  overlays?: StoryRailOverlay[];
  labels?: {
    mediaFailure: string;
    retry: string;
    mute: string;
    unmute: string;
    play?: string;
    processing?: string;
  };
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

function OverlayLayer({ overlays }: { overlays?: StoryRailOverlay[] }) {
  if (!overlays?.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-testid="story-overlays">
      {overlays.map((overlay) => {
        const style: React.CSSProperties = {
          left: `${overlay.x}%`,
          top: `${overlay.y}%`,
          width: overlay.width ? `${overlay.width}%` : undefined,
          height: overlay.height ? `${overlay.height}%` : undefined,
          transform: `translate(-50%, -50%) rotate(${overlay.rotation ?? 0}deg)`,
          color: overlay.fontColor,
          fontFamily: overlay.fontFamily,
          fontSize: overlay.fontSize ? `${overlay.fontSize}px` : undefined,
        };
        if (overlay.type === "sticker" && overlay.imageUrl) {
          return <img key={overlay.id} src={overlay.imageUrl} alt="" aria-hidden className="absolute object-contain" style={style} />;
        }
        if (overlay.type === "shape") {
          return <span key={overlay.id} aria-hidden className="absolute rounded-2xl" style={{ ...style, backgroundColor: overlay.fontColor ?? "#ffffff" }} />;
        }
        return <span key={overlay.id} className="absolute whitespace-pre-wrap text-center font-peyda font-semibold drop-shadow" style={style}>{overlay.content}</span>;
      })}
    </div>
  );
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
  /** A decoded frame is actually on screen; until then the poster stays on top. */
  const [firstFrame, setFirstFrame] = useState(false);
  /** Even muted autoplay was refused (Low Power Mode, data saver): offer tap-to-play. */
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

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
    let retriedMuted = false;
    let failureReported = false;
    let autoplayReported = false;
    let lastTime = 0;

    const held = () => isHeld(stateRef.current.holds);
    const reportOnce = (failure: MediaFailureKind, code: number | null) => {
      if (failure === "autoplay-denied") {
        if (autoplayReported) return;
        autoplayReported = true;
      } else {
        if (failureReported) return;
        failureReported = true;
      }
      report(failure, code);
    };

    // The shared engine owns the source, first-frame detection, the "plays but decodes
    // nothing" probe (Chromium without HEVC), error classification and teardown. Stories
    // stay on the progressive MP4: clips are seconds long and the next one is pre-warmed,
    // so HLS would add playlist round trips without room for adaptation to pay them back.
    const source: VideoSource = payload.video ?? { mp4: payload.src, poster: payload.poster ?? null };
    const engine = createVideoEngine(video, source, {
      surface: "story",
      allowHls: false,
      preload: "auto",
      onFirstFrame: () => {
        if (!disposed) setFirstFrame(true);
      },
      onFatal: (failure) => {
        if (disposed || stateRef.current.generation !== generation) return;
        if (failure === "decode-unsupported" && payload.poster) {
          // Nothing decoded; show the cover as a still for the configured duration.
          dispatch({ type: "fallback", generation, durationMs: payload.durationMs });
        } else {
          dispatch({ type: "failed", generation, failure });
        }
        reportOnce(failure, video.error?.code ?? null);
      },
    });

    const attemptPlay = () => {
      if (disposed || held()) return;
      engine.markPlayRequested();
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
          // Genuinely blocked (Low Power Mode, data saver). Stay out of `playing` — the UI
          // must not pretend otherwise — and let the viewer start it with a tap.
          setAutoplayBlocked(true);
          reportOnce("autoplay-denied", null);
          return;
        }
        if (name === "NotSupportedError") {
          if (engine.recoverDecodeFailure()) return;
          dispatch({ type: "failed", generation, failure: "decode-unsupported" });
          reportOnce("decode-unsupported", video.error?.code ?? null);
          return;
        }
        dispatch({ type: "failed", generation, failure: "network" });
        reportOnce("network", video.error?.code ?? null);
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
      lastTime = video.currentTime;
      setAutoplayBlocked(false);
      dispatch({ type: "playing", generation });
    };
    const onWaiting = () => dispatch({ type: "waiting", generation });
    // `stalled` is deliberately not treated as buffering: it reports a slow network, not a
    // stopped video. When playback carries on from buffer no `playing` follows, and the
    // old mapping froze the progress bar until `ended`. Time moving again ends buffering.
    const onTimeUpdate = () => {
      if (
        stateRef.current.phase === "buffering" &&
        !video.paused &&
        video.currentTime > lastTime + 0.01
      ) {
        dispatch({ type: "playing", generation });
      }
      lastTime = video.currentTime;
    };
    const onEnded = () => {
      dispatch({ type: "ended", generation });
      dispatch({ type: "advance-requested", generation });
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
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);

    engine.load();

    // The element may already be past these by the time the effect runs.
    if (video.readyState >= 1) onLoadedMetadata();
    if (video.readyState >= 2) onReady();
    else attemptPlay();

    return () => {
      disposed = true;
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
      // Silence first, then release: the engine pauses, and detaches the source so the
      // decoder and any in-flight range request are freed now, not at garbage collection
      // (WebKit keeps downloading for a merely detached element).
      video.muted = true;
      engine.dispose();
      // The next element (a re-activation or a retry) starts without a presented frame.
      setFirstFrame(false);
    };
    // `payload.poster`/`durationMs`/`src` are fixed for this mount (the surface remounts
    // per story), so this effect runs exactly once per media element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingVideoElement, generation]);

  // ── Tell the viewer when warming the next story is safe ──────────────────────
  useEffect(() => {
    if (!store || !isActive) return;
    if (payload.kind !== "video" || state.phase === "fallback") {
      if (state.hasPresented) store.publishReadyForNext(item.id);
      return;
    }
    const video = videoRef.current;
    if (!video || !showingVideoElement) return;
    const check = () => {
      const { buffered, currentTime, duration } = video;
      if (!buffered || buffered.length === 0) return;
      const end = buffered.end(buffered.length - 1);
      if (end - currentTime >= 4 || (Number.isFinite(duration) && duration > 0 && end >= duration - 0.25)) {
        store.publishReadyForNext(item.id);
      }
    };
    video.addEventListener("progress", check);
    video.addEventListener("timeupdate", check);
    check();
    return () => {
      video.removeEventListener("progress", check);
      video.removeEventListener("timeupdate", check);
    };
  }, [store, isActive, item.id, payload.kind, state.phase, state.hasPresented, showingVideoElement]);

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
  // For video, the poster covers everything but a live element with a presented frame. That
  // includes an inactive face mid cube-turn, whose element is already gone: without the
  // poster, the story being left would turn black for the whole rotation.
  const showPoster =
    Boolean(posterUrl) &&
    (state.phase === "fallback" || (isVideo ? !showingVideoElement || !firstFrame : !state.hasPresented));
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
        // `src` is declarative so the fetch starts when React creates the element. When the
        // viewer opens, that is during the render React holds back before revealing the lazy
        // viewer (~300 ms before any effect runs). The engine adopts the source rather than
        // re-attaching it, which follows the same capability selection as the engine and every item gets
        // its own keyed element. No opacity trick: the poster is layered above instead,
        // because some engines do not present frames for a fully transparent element, and
        // a presented frame is what the poster waits for.
        <video
          ref={videoRef}
          src={payload.video && chooseEngine(payload.video, { allowHls: false }) === "webm" ? payload.video.webm! : payload.video?.mp4 ?? payload.src}
          className="relative h-full w-full object-contain"
          playsInline
          preload="auto"
          controls={false}
          disablePictureInPicture
          controlsList="nodownload noplaybackrate noremoteplayback"
        />
      ) : null}

      {posterUrl ? (
        <img
          src={posterUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          style={{ opacity: showPoster ? 1 : 0 }}
        />
      ) : null}

      {isVideo && state.phase === "fallback" && payload.video?.processing ? (
        <p
          data-testid="story-media-processing"
          className="pointer-events-none absolute inset-x-6 bottom-24 z-10 rounded-full bg-black/55 px-4 py-2 text-center font-peyda text-sm text-white"
        >
          {payload.labels?.processing ?? "This video is still being prepared."}
        </p>
      ) : null}

      {state.phase !== "error" ? <OverlayLayer overlays={payload.overlays} /> : null}

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
          aria-label={audioEnabled ? (payload.labels?.mute ?? "Mute") : (payload.labels?.unmute ?? "Play sound")}
          aria-pressed={audioEnabled}
          className={`absolute right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${ctaUrl ? "bottom-20" : "bottom-6"}`}
        >
          <SpeakerIcon muted={!audioEnabled} />
        </button>
      ) : null}

      {isVideo && isActive && autoplayBlocked && state.phase !== "error" ? (
        <button
          type="button"
          data-testid="story-tap-to-play"
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            const video = videoRef.current;
            if (!video) return;
            // Inside the tap, so the browser treats it as user-initiated.
            setAutoplayBlocked(false);
            const playPromise = video.play();
            if (playPromise && typeof playPromise.catch === "function") {
              playPromise.catch(() => setAutoplayBlocked(true));
            }
          }}
          onPointerDown={stopTap}
          onPointerUp={stopTap}
          onMouseDown={stopTap}
          onMouseUp={stopTap}
          onTouchStart={stopTap}
          onTouchEnd={stopTap}
          aria-label={payload.labels?.play ?? "Play"}
          className="absolute inset-0 z-20 m-auto flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <svg viewBox="0 0 24 24" className="h-7 w-7 translate-x-0.5" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      ) : null}

      {showSpinner && !autoplayBlocked ? (
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
            {payload.labels?.mediaFailure ?? "This story cannot be played in this browser."}
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
            {payload.labels?.retry ?? "Try again"}
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
