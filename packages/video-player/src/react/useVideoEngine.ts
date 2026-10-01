"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PlaybackEngine } from "../capabilities";
import type { VideoSource } from "../delivery";
import { createVideoEngine, type EngineFailure, type PlayOutcome, type VideoEngine } from "../engine";

export type InlinePhase = "idle" | "loading" | "playing" | "paused" | "buffering" | "ended" | "error";

export interface VideoEngineState {
  phase: InlinePhase;
  hasFirstFrame: boolean;
  failure: EngineFailure | "autoplay-denied" | null;
  engine: PlaybackEngine | null;
  muted: boolean;
}

export interface UseVideoEngineOptions {
  /** Engine alive and source attached. Inactive means poster only: no requests, no decoder. */
  active: boolean;
  /** Desired play state while active. */
  playing: boolean;
  muted: boolean;
  loop?: boolean;
  surface: string;
  allowHls?: boolean;
  preload?: "none" | "metadata" | "auto";
  onEnded?: () => void;
}

const IDLE: VideoEngineState = {
  phase: "idle",
  hasFirstFrame: false,
  failure: null,
  engine: null,
  muted: true,
};

/**
 * Binds one `<video>` to the playback engine for surfaces whose UX is "play this when
 * it is the active item" — the product gallery and the post carousel. Stories drive the
 * engine directly because they have their own playback state machine.
 */
export function useVideoEngine(
  videoRef: RefObject<HTMLVideoElement | null>,
  source: VideoSource | null,
  options: UseVideoEngineOptions,
) {
  const [state, setState] = useState<VideoEngineState>(IDLE);
  const [attempt, setAttempt] = useState(0);
  /** Bumped per engine so the play/pause effect re-evaluates against the new one. */
  const [generation, setGeneration] = useState(0);
  const engineRef = useRef<VideoEngine | null>(null);
  /** Which engine the current play intent was already issued to — exactly one play() each. */
  const playedRef = useRef<{ engine: VideoEngine | null; playing: boolean }>({ engine: null, playing: false });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const requestPlay = useCallback(async (): Promise<PlayOutcome> => {
    const engine = engineRef.current;
    const video = videoRef.current;
    if (!engine || !video) return "aborted";
    const outcome = await engine.play({ mutedFallback: true });
    if (outcome === "autoplay-denied") {
      setState((current) => ({ ...current, phase: "paused", failure: "autoplay-denied" }));
    } else if (outcome === "playing") {
      setState((current) => (current.failure === "autoplay-denied" ? { ...current, failure: null } : current));
    }
    return outcome;
  }, [videoRef]);

  const mp4 = source?.mp4 ?? "";
  const hls = source?.hls ?? "";
  const webm = source?.webm ?? "";

  // ── Engine lifecycle: one engine per (element, source, activation) ──────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !options.active || !source) {
      setState(IDLE);
      return;
    }
    const engine = createVideoEngine(video, source, {
      surface: options.surface,
      allowHls: options.allowHls,
      preload: options.preload,
      onFirstFrame: () => setState((current) => ({ ...current, hasFirstFrame: true })),
      onFatal: (failure) => setState((current) => ({ ...current, phase: "error", failure })),
      onEngineChange: (next) => setState((current) => ({ ...current, engine: next })),
    });
    engineRef.current = engine;
    video.muted = optionsRef.current.muted;
    video.loop = Boolean(optionsRef.current.loop);
    setState({ phase: "loading", hasFirstFrame: false, failure: null, engine: engine.engine, muted: video.muted });

    const update = (phase: InlinePhase) =>
      setState((current) => (current.phase === "error" ? current : { ...current, phase }));
    const onPlaying = () => update("playing");
    const onPause = () => update("paused");
    const onWaiting = () => update("buffering");
    const onEnded = () => {
      update("ended");
      optionsRef.current.onEnded?.();
    };
    const onVolume = () => setState((current) => ({ ...current, muted: video.muted }));
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("volumechange", onVolume);

    engine.load();
    setGeneration((value) => value + 1);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("volumechange", onVolume);
      if (engineRef.current === engine) engineRef.current = null;
      engine.dispose();
    };
    // `source` is identified by its URLs; a new object with the same URLs is the same video.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.active, mp4, hls, webm, options.allowHls, options.surface, options.preload, attempt, videoRef, requestPlay]);

  // ── Follow the desired play/mute state ──────────────────────────────────────────────
  // Play is issued once per engine and per paused→playing change, never on every render:
  // a rejected play() leaves the element paused, and re-issuing it would loop.
  useEffect(() => {
    const video = videoRef.current;
    const engine = engineRef.current;
    if (!video || !engine) return;
    video.loop = Boolean(options.loop);
    if (video.muted !== options.muted) video.muted = options.muted;
    const last = playedRef.current;
    if (options.playing) {
      if (last.engine !== engine || !last.playing) {
        playedRef.current = { engine, playing: true };
        void requestPlay();
      }
    } else {
      playedRef.current = { engine, playing: false };
      if (!video.paused) video.pause();
    }
  }, [options.playing, options.muted, options.loop, generation, videoRef, requestPlay]);

  const pause = useCallback(() => videoRef.current?.pause(), [videoRef]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, play: requestPlay, pause, retry };
}
