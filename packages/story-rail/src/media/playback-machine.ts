/**
 * The single source of truth for the active story's playback.
 *
 * There is exactly one of these alive at a time, and it is the only thing allowed to
 * decide whether a story is presenting, whether its progress bar moves, and when the
 * viewer advances. The package's own wall-clock timer is inert (see patches/README.md,
 * edit E2), so nothing else can move progress or navigate behind this reducer's back.
 *
 * `phase` describes the media. `holds` describes who is currently preventing playback.
 * They are separate because they are genuinely orthogonal — a story can be buffering
 * *and* held by a press-and-hold — and collapsing them into one enum is what produces
 * the impossible combinations (`playing && !canPlay`, `loaded && buffering`) this
 * replaces.
 */

export type PlaybackPhase =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "buffering"
  | "ended"
  | "error"
  /** Media loaded and reports no error, but its video track yields no frames. */
  | "fallback";

export type MediaFailureKind =
  | "autoplay-denied"
  | "decode-unsupported"
  | "network"
  | "stall"
  | "abort"
  | "unknown";

/** Who is holding playback. Playback runs only when every hold is false. */
export interface PlaybackHolds {
  /** Press-and-hold, keyboard space, or a drag — reported by the viewer. */
  user: boolean;
  /** document.visibilityState !== "visible". */
  hidden: boolean;
  /** This story is not the live cube face. */
  inactive: boolean;
}

export interface PlaybackState {
  /** Bumped on every story identity change; stale async events carry an older value. */
  generation: number;
  phase: PlaybackPhase;
  holds: PlaybackHolds;
  /** 0..1, monotonic within a generation. */
  progress: number;
  /** Authoritative duration in ms: the video's real duration once known, else the
   *  story's configured DurationMs. 0 means "not yet known". */
  durationMs: number;
  failure: MediaFailureKind | null;
  /** Set once when this story has asked the viewer to advance. Never unset within a
   *  generation, which is what makes "advance exactly once" structural. */
  advanceRequested: boolean;
  /** True once playback has genuinely started at least once this generation. Used to
   *  keep the poster visible until there is a real frame to show. */
  hasPresented: boolean;
  /** Incremented by an explicit user retry, to force a fresh media element. */
  attempt: number;
}

export type PlaybackAction =
  | { type: "reset"; generation: number; durationMs: number }
  | { type: "loading"; generation: number }
  | { type: "metadata"; generation: number; durationMs: number }
  | { type: "ready"; generation: number }
  | { type: "playing"; generation: number }
  | { type: "waiting"; generation: number }
  | { type: "progress"; generation: number; value: number }
  | { type: "ended"; generation: number }
  | { type: "failed"; generation: number; failure: MediaFailureKind }
  | { type: "fallback"; generation: number; durationMs: number }
  | { type: "advance-requested"; generation: number }
  | { type: "hold"; hold: keyof PlaybackHolds; value: boolean }
  | { type: "retry" };

const NO_HOLDS: PlaybackHolds = { user: false, hidden: false, inactive: false };

export function isHeld(holds: PlaybackHolds): boolean {
  return holds.user || holds.hidden || holds.inactive;
}

/** A story is presenting once there is something real on screen to look at. */
export function isPresenting(state: PlaybackState): boolean {
  return (
    state.phase === "playing" ||
    state.phase === "buffering" ||
    state.phase === "ended" ||
    state.phase === "fallback"
  );
}

/** Progress may only move while the media is genuinely playing and nothing holds it. */
export function isProgressRunning(state: PlaybackState): boolean {
  return (state.phase === "playing" || state.phase === "fallback") && !isHeld(state.holds);
}

/** Terminal states still let the user navigate; they must never trap the viewer. */
export function isTerminal(state: PlaybackState): boolean {
  return state.phase === "ended" || state.phase === "error";
}

export function initialPlaybackState(generation: number, durationMs: number): PlaybackState {
  return {
    generation,
    phase: "idle",
    holds: NO_HOLDS,
    progress: 0,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
    failure: null,
    advanceRequested: false,
    hasPresented: false,
    attempt: 0,
  };
}

/** Duration guard: browsers report NaN before metadata, Infinity for live streams, and
 *  0 for a media element whose track never decoded. None of those may reach progress. */
function usableDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  // Holds and retry are viewer-level, not media-level: they are never stale.
  if (action.type === "hold") {
    if (state.holds[action.hold] === action.value) return state;
    return { ...state, holds: { ...state.holds, [action.hold]: action.value } };
  }

  if (action.type === "retry") {
    return {
      ...initialPlaybackState(state.generation, state.durationMs),
      holds: state.holds,
      attempt: state.attempt + 1,
    };
  }

  if (action.type === "reset") {
    return {
      ...initialPlaybackState(action.generation, action.durationMs),
      // A hold that is still true across a story change (finger down, tab hidden,
      // inactive face) must survive, or the new story would start playing under it.
      holds: state.holds,
    };
  }

  // Everything below originates from a media element or a timer. Anything carrying a
  // generation other than the current one belongs to a story we have already left:
  // a settled play() promise, a late `canplay`, a queued rAF callback.
  if (action.generation !== state.generation) return state;

  // Once a story has failed, fallen back, or ended, further media noise is ignored.
  // This is what stops the Chromium HEVC case (which keeps "playing" happily) from
  // walking itself back out of `fallback`.
  if (state.phase === "error" || state.phase === "fallback" || state.phase === "ended") {
    if (action.type === "advance-requested") {
      return state.advanceRequested ? state : { ...state, advanceRequested: true };
    }
    if (action.type === "progress" && state.phase === "fallback") {
      const value = Math.min(Math.max(action.value, state.progress), 1);
      return value === state.progress ? state : { ...state, progress: value };
    }
    return state;
  }

  switch (action.type) {
    case "metadata": {
      const durationMs = usableDuration(action.durationMs);
      if (!durationMs || durationMs === state.durationMs) return state;
      return { ...state, durationMs };
    }

    case "loading":
      return state.phase === "idle" ? { ...state, phase: "loading" } : state;

    case "ready":
      // Ready is not playing. Progress stays put until a real `playing` event.
      return state.phase === "idle" || state.phase === "loading"
        ? { ...state, phase: "ready" }
        : state;

    case "playing":
      return { ...state, phase: "playing", hasPresented: true, failure: null };

    case "waiting":
      // Buffering keeps the current frame and freezes progress; it is never a skip.
      return state.phase === "playing" ? { ...state, phase: "buffering" } : state;

    case "progress": {
      if (!isProgressRunning(state)) return state;
      // Monotonic within a generation so a late sample can never rewind the bar.
      const value = Math.min(Math.max(action.value, state.progress), 1);
      return value === state.progress ? state : { ...state, progress: value };
    }

    case "ended":
      return { ...state, phase: "ended", progress: 1 };

    case "failed":
      return { ...state, phase: "error", failure: action.failure };

    case "fallback":
      // The video decoded nothing. Show the poster for the configured duration and
      // treat the story as a still from here on.
      return {
        ...state,
        phase: "fallback",
        failure: "decode-unsupported",
        hasPresented: true,
        progress: 0,
        durationMs: usableDuration(action.durationMs) || state.durationMs,
      };

    case "advance-requested":
      return state.advanceRequested ? state : { ...state, advanceRequested: true };

    default:
      return state;
  }
}
