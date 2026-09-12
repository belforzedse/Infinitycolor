import {
  initialPlaybackState,
  isHeld,
  isProgressRunning,
  isTerminal,
  playbackReducer,
  type PlaybackState,
} from "../media/playback-machine";

const GEN = 7;

function base(): PlaybackState {
  return initialPlaybackState(GEN, 5000);
}

function run(state: PlaybackState, ...actions: Parameters<typeof playbackReducer>[1][]) {
  return actions.reduce(playbackReducer, state);
}

describe("playback machine", () => {
  it("starts idle with no progress and no holds", () => {
    const state = base();
    expect(state.phase).toBe("idle");
    expect(state.progress).toBe(0);
    expect(isHeld(state.holds)).toBe(false);
    expect(isProgressRunning(state)).toBe(false);
  });

  it("does not run progress until playback genuinely starts", () => {
    const loading = run(base(), { type: "loading", generation: GEN });
    expect(isProgressRunning(loading)).toBe(false);

    const ready = run(loading, { type: "ready", generation: GEN });
    expect(ready.phase).toBe("ready");
    // `ready` means presentable, not playing. Progress must stay frozen.
    expect(isProgressRunning(ready)).toBe(false);

    const playing = run(ready, { type: "playing", generation: GEN });
    expect(isProgressRunning(playing)).toBe(true);
  });

  it("ignores every action belonging to a story the viewer has left", () => {
    const playing = run(base(), { type: "playing", generation: GEN });
    const stale = GEN - 1;

    const after = run(
      playing,
      { type: "progress", generation: stale, value: 0.9 },
      { type: "metadata", generation: stale, durationMs: 90_000 },
      { type: "ended", generation: stale },
      { type: "failed", generation: stale, failure: "network" },
      { type: "advance-requested", generation: stale },
    );

    expect(after).toBe(playing);
    expect(after.progress).toBe(0);
    expect(after.advanceRequested).toBe(false);
  });

  it("freezes progress while buffering and resumes from the same position", () => {
    let state = run(
      base(),
      { type: "playing", generation: GEN },
      { type: "progress", generation: GEN, value: 0.4 },
      { type: "waiting", generation: GEN },
    );
    expect(state.phase).toBe("buffering");
    expect(isProgressRunning(state)).toBe(false);

    // A sample that arrives while stalled must not move the bar.
    state = run(state, { type: "progress", generation: GEN, value: 0.7 });
    expect(state.progress).toBe(0.4);

    state = run(state, { type: "playing", generation: GEN });
    expect(state.progress).toBe(0.4);
    expect(isProgressRunning(state)).toBe(true);
  });

  it.each([["user"], ["hidden"], ["inactive"]] as const)(
    "freezes progress while held by %s",
    (hold) => {
      let state = run(base(), { type: "playing", generation: GEN });
      state = run(state, { type: "hold", hold, value: true });
      expect(isProgressRunning(state)).toBe(false);

      state = run(state, { type: "progress", generation: GEN, value: 0.5 });
      expect(state.progress).toBe(0);

      state = run(state, { type: "hold", hold, value: false });
      expect(isProgressRunning(state)).toBe(true);
    },
  );

  it("never rewinds progress within a generation", () => {
    const state = run(
      base(),
      { type: "playing", generation: GEN },
      { type: "progress", generation: GEN, value: 0.6 },
      { type: "progress", generation: GEN, value: 0.2 },
    );
    expect(state.progress).toBe(0.6);
  });

  it("requests an advance at most once", () => {
    const state = run(
      base(),
      { type: "playing", generation: GEN },
      { type: "ended", generation: GEN },
      { type: "advance-requested", generation: GEN },
    );
    expect(state.advanceRequested).toBe(true);
    expect(state.progress).toBe(1);

    const again = run(state, { type: "advance-requested", generation: GEN });
    // Same object: nothing re-triggers the effect that calls next().
    expect(again).toBe(state);
  });

  it("ignores media events once the story has ended", () => {
    const ended = run(base(), { type: "playing", generation: GEN }, { type: "ended", generation: GEN });
    const after = run(
      ended,
      { type: "playing", generation: GEN },
      { type: "waiting", generation: GEN },
      { type: "progress", generation: GEN, value: 0.1 },
    );
    expect(after.phase).toBe("ended");
    expect(isTerminal(after)).toBe(true);
  });

  it("keeps a fallback story on its poster clock and ignores further media noise", () => {
    let state = run(
      base(),
      { type: "playing", generation: GEN },
      { type: "fallback", generation: GEN, durationMs: 4000 },
    );
    expect(state.phase).toBe("fallback");
    expect(state.failure).toBe("decode-unsupported");
    expect(state.durationMs).toBe(4000);
    expect(isProgressRunning(state)).toBe(true);

    // The Chromium HEVC case keeps firing `playing` and advancing currentTime; none of
    // that may drag the story back out of the poster fallback.
    state = run(state, { type: "playing", generation: GEN }, { type: "ended", generation: GEN });
    expect(state.phase).toBe("fallback");

    // The poster's own wall clock still drives the bar.
    state = run(state, { type: "progress", generation: GEN, value: 0.5 });
    expect(state.progress).toBe(0.5);
  });

  it("rejects unusable durations so progress cannot divide by them", () => {
    for (const durationMs of [NaN, 0, -1, Infinity]) {
      const state = run(base(), { type: "metadata", generation: GEN, durationMs });
      expect(state.durationMs).toBe(5000);
    }
    const real = run(base(), { type: "metadata", generation: GEN, durationMs: 10_265 });
    expect(real.durationMs).toBe(10_265);
  });

  it("carries active holds across a story change so the next story does not auto-start", () => {
    const held = run(base(), { type: "hold", hold: "user", value: true });
    const next = run(held, { type: "reset", generation: GEN + 1, durationMs: 3000 });

    expect(next.generation).toBe(GEN + 1);
    expect(next.phase).toBe("idle");
    expect(next.progress).toBe(0);
    expect(next.durationMs).toBe(3000);
    expect(next.holds.user).toBe(true);
    expect(next.advanceRequested).toBe(false);
  });

  it("retry clears the failure and forces a fresh media element", () => {
    const failed = run(base(), { type: "failed", generation: GEN, failure: "network" });
    expect(failed.phase).toBe("error");

    const retried = run(failed, { type: "retry" });
    expect(retried.phase).toBe("idle");
    expect(retried.failure).toBeNull();
    expect(retried.attempt).toBe(1);
  });
});
