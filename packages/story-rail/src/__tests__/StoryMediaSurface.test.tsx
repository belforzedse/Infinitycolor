import React from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { StoryMediaSurface, type StoryMediaPayload } from "../media/StoryMediaSurface";
import { StoryPlaybackContext, createPlaybackStore } from "../media/playback-store";
import { controlMedia, installMediaStub, uninstallMediaStub } from "./media-stub";

const VIDEO_SRC = "https://cdn.test/uploads/story.mp4";
const POSTER_SRC = "https://cdn.test/uploads/story-cover.webp";

function payloadFor(overrides: Partial<StoryMediaPayload> = {}): StoryMediaPayload {
  return {
    storyId: 1,
    kind: "video",
    src: VIDEO_SRC,
    poster: POSTER_SRC,
    title: "استوری",
    durationMs: 5000,
    ...overrides,
  };
}

function renderSurface(
  payload: StoryMediaPayload,
  options: { isActive?: boolean; isPaused?: boolean; itemId?: string } = {},
) {
  const next = jest.fn();
  const store = createPlaybackStore();
  const noop = () => undefined;

  const view = render(
    <StoryPlaybackContext.Provider value={store}>
      <StoryMediaSurface
        pause={noop}
        resume={noop}
        next={next}
        prev={noop}
        setDuration={noop}
        item={{ id: options.itemId ?? "item-1", metadata: payload }}
        isActive={options.isActive ?? true}
        isPaused={options.isPaused ?? false}
      />
    </StoryPlaybackContext.Provider>,
  );

  const rerenderWith = (
    nextPayload: StoryMediaPayload,
    nextOptions: { isActive?: boolean; isPaused?: boolean; itemId?: string } = {},
  ) =>
    view.rerender(
      <StoryPlaybackContext.Provider value={store}>
        <StoryMediaSurface
          pause={noop}
          resume={noop}
          next={next}
          prev={noop}
          setDuration={noop}
          item={{ id: nextOptions.itemId ?? options.itemId ?? "item-1", metadata: nextPayload }}
          isActive={nextOptions.isActive ?? true}
          isPaused={nextOptions.isPaused ?? false}
        />
      </StoryPlaybackContext.Provider>,
    );

  const video = () => view.container.querySelector("video");
  const progress = () => store.getSnapshot().progress;

  return { next, store, view, rerenderWith, video, progress };
}

/** Drives a video from mount to genuinely playing, the way a healthy browser would. */
async function reachPlaying(
  media: ReturnType<typeof controlMedia>,
  { durationSeconds = 5 }: { durationSeconds?: number } = {},
) {
  await act(async () => {
    media.set({ readyState: 4, duration: durationSeconds, videoWidth: 1080, videoHeight: 1920 });
    media.emit("loadedmetadata");
    media.emit("canplay");
    await media.resolvePlay();
  });
  await act(async () => {
    media.emit("playing");
  });
}

/** Flushes the throttled progress publish so the store snapshot is current. */
async function flushProgress(ms = 200) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  installMediaStub();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  uninstallMediaStub();
  jest.clearAllMocks();
});

describe("StoryMediaSurface — video", () => {
  it("does not move progress until the video genuinely starts playing", async () => {
    const { video, progress } = renderSurface(payloadFor());
    const media = controlMedia(video()!);

    await act(async () => {
      media.set({ readyState: 4, duration: 10, videoWidth: 1080, videoHeight: 1920 });
      media.emit("loadedmetadata");
      media.emit("canplay");
      await media.resolvePlay();
    });

    // `canplay` fired and play() resolved, but no `playing` event yet.
    await flushProgress(1000);
    expect(progress()).toBe(0);

    await act(async () => {
      media.emit("playing");
    });
    media.set({ currentTime: 5 });
    await flushProgress();

    expect(progress()).toBeCloseTo(0.5, 2);
  });

  it("tracks the real media duration, not the story's configured one", async () => {
    // Production rows carry DurationMs: 3000 for videos that are actually ~10s long.
    const { video, progress } = renderSurface(payloadFor({ durationMs: 3000 }));
    const media = controlMedia(video()!);
    await reachPlaying(media, { durationSeconds: 10 });

    media.set({ currentTime: 5 });
    await flushProgress();
    // Half of the real 10s, not past the end of the declared 3s.
    expect(progress()).toBeCloseTo(0.5, 2);
  });

  it("freezes progress while buffering and resumes from the same position", async () => {
    const { video, progress } = renderSurface(payloadFor());
    const media = controlMedia(video()!);
    await reachPlaying(media, { durationSeconds: 10 });

    media.set({ currentTime: 3 });
    await flushProgress();
    expect(progress()).toBeCloseTo(0.3, 2);

    await act(async () => {
      media.emit("waiting");
    });
    // A stalled video keeps its currentTime; the bar must not creep forward either.
    await flushProgress(2000);
    expect(progress()).toBeCloseTo(0.3, 2);

    await act(async () => {
      media.emit("playing");
    });
    media.set({ currentTime: 6 });
    await flushProgress();
    expect(progress()).toBeCloseTo(0.6, 2);
  });

  it("shows no spinner for a stall too short to notice", async () => {
    const { video } = renderSurface(payloadFor());
    const media = controlMedia(video()!);
    await reachPlaying(media);

    await act(async () => {
      media.emit("waiting");
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("story-media-spinner")).not.toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(screen.getByTestId("story-media-spinner")).toBeInTheDocument();
  });

  it("advances exactly once when the video ends", async () => {
    const { video, next } = renderSurface(payloadFor());
    const media = controlMedia(video()!);
    await reachPlaying(media, { durationSeconds: 5 });

    await act(async () => {
      media.set({ currentTime: 5 });
      media.emit("ended");
    });
    // A second `ended`, plus the progress clock reaching 100%, must not navigate again.
    await act(async () => {
      media.emit("ended");
      jest.advanceTimersByTime(2000);
    });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("never advances from progress alone while the video is still playing", async () => {
    const { video, next } = renderSurface(payloadFor());
    const media = controlMedia(video()!);
    await reachPlaying(media, { durationSeconds: 5 });

    // currentTime past duration without an `ended` event (seek/rounding).
    media.set({ currentTime: 6 });
    await flushProgress(1000);

    expect(next).not.toHaveBeenCalled();
  });
});

describe("StoryMediaSurface — autoplay", () => {
  it("falls back to muted playback when audible autoplay is refused", async () => {
    const { video, store } = renderSurface(payloadFor());
    const element = video()!;
    const media = controlMedia(element);

    store.audio.set(true);
    await act(async () => {
      element.muted = false;
      media.emit("canplay");
    });

    const callsBefore = media.playCalls();
    await act(async () => {
      await media.rejectPlay("NotAllowedError");
    });

    expect(element.muted).toBe(true);
    expect(store.audio.getSnapshot()).toBe(false);
    expect(media.playCalls()).toBeGreaterThan(callsBefore);
  });

  it("does not claim to be playing when autoplay is refused outright", async () => {
    const { video, progress } = renderSurface(payloadFor());
    const media = controlMedia(video()!);

    await act(async () => {
      media.set({ readyState: 4, duration: 5, videoWidth: 1080, videoHeight: 1920 });
      media.emit("canplay");
    });
    // Already muted, so there is no fallback left to try.
    await act(async () => {
      await media.rejectPlay("NotAllowedError");
    });

    await flushProgress(1500);
    expect(progress()).toBe(0);
    expect(screen.queryByTestId("story-media-error")).not.toBeInTheDocument();
  });

  it("treats AbortError as navigation, not as a broken video", async () => {
    const { video } = renderSurface(payloadFor());
    const media = controlMedia(video()!);

    await act(async () => {
      media.emit("canplay");
      await media.rejectPlay("AbortError");
    });

    expect(screen.queryByTestId("story-media-error")).not.toBeInTheDocument();
  });
});

describe("StoryMediaSurface — undecodable and broken media", () => {
  it("falls back to the cover image when the video track decodes no frames", async () => {
    // Production's HEVC-in-.mov: Chromium reports readyState 4, fires `playing` and
    // advances currentTime while decoding nothing, and never fires `error`.
    const { video, progress, next } = renderSurface(payloadFor({ durationMs: 4000 }));
    const media = controlMedia(video()!);

    await act(async () => {
      media.set({ readyState: 4, duration: 10, videoWidth: 0, videoHeight: 0, totalVideoFrames: 0 });
      media.emit("loadedmetadata");
      media.emit("canplay");
      await media.resolvePlay();
    });
    await act(async () => {
      media.emit("playing");
    });
    // The signature of the real failure: the pipeline is running — currentTime advances —
    // while the decoder produces nothing and no `error` is ever fired.
    media.set({ currentTime: 0.5 });
    await act(async () => {
      jest.advanceTimersByTime(1400);
    });

    // The <video> is gone — it must not keep streaming tens of megabytes under a poster.
    expect(video()).toBeNull();
    expect(screen.queryByTestId("story-media-error")).not.toBeInTheDocument();
    const poster = document.querySelector(`img[src="${POSTER_SRC}"]`);
    expect(poster).toBeInTheDocument();

    // The story now runs on the poster's own clock and still advances.
    await flushProgress(2000);
    expect(progress()).toBeGreaterThan(0);
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a stalled video for an undecodable one", async () => {
    const { video } = renderSurface(payloadFor());
    const media = controlMedia(video()!);

    await act(async () => {
      media.set({ readyState: 4, duration: 10, videoWidth: 0, videoHeight: 0, totalVideoFrames: 0 });
      media.emit("canplay");
      await media.resolvePlay();
    });
    await act(async () => {
      media.emit("playing");
    });
    // currentTime never advances: this is a stall, which the buffering path owns. Falling
    // back here would replace a recoverable video with a still image.
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    expect(video()).not.toBeNull();
    expect(screen.queryByTestId("story-media-error")).not.toBeInTheDocument();
  });

  it("shows a retryable error, and never a spinner forever, when media cannot load", async () => {
    const { video, next } = renderSurface(payloadFor({ poster: undefined }));
    const media = controlMedia(video()!);

    await act(async () => {
      media.fail(2); // MEDIA_ERR_NETWORK
    });

    expect(screen.getByTestId("story-media-error")).toBeInTheDocument();
    expect(screen.queryByTestId("story-media-spinner")).not.toBeInTheDocument();
    // A dead story must not trap the viewer by auto-skipping or by blocking navigation.
    expect(next).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    });
    expect(screen.queryByTestId("story-media-error")).not.toBeInTheDocument();
    expect(video()).not.toBeNull();
  });

  it("reports a sanitised media failure without query parameters", async () => {
    const issues: unknown[] = [];
    const store = createPlaybackStore((issue) => issues.push(issue));
    const noop = () => undefined;
    const { container } = render(
      <StoryPlaybackContext.Provider value={store}>
        <StoryMediaSurface
          pause={noop}
          resume={noop}
          next={noop}
          prev={noop}
          setDuration={noop}
          item={{
            id: "item-1",
            metadata: payloadFor({ src: "https://cdn.test/uploads/a.mp4?token=SECRET", poster: undefined }),
          }}
          isActive
          isPaused={false}
        />
      </StoryPlaybackContext.Provider>,
    );

    await act(async () => {
      controlMedia(container.querySelector("video")!).fail(4);
    });

    expect(issues).toEqual([
      expect.objectContaining({
        storyId: 1,
        mediaType: "video",
        mediaHost: "cdn.test",
        mediaPath: "/uploads/a.mp4",
        failure: "decode-unsupported",
        mediaErrorCode: 4,
      }),
    ]);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });
});

describe("StoryMediaSurface — lifecycle", () => {
  it("ignores events and a settling play() promise from the story just left", async () => {
    const { video, next, progress, rerenderWith } = renderSurface(payloadFor(), { itemId: "item-1" });
    const first = video()!;
    const firstMedia = controlMedia(first);

    await act(async () => {
      firstMedia.set({ readyState: 4, duration: 10, videoWidth: 1080, videoHeight: 1920 });
      firstMedia.emit("canplay");
    });

    // Move to the next story while the first story's play() is still in flight.
    await act(async () => {
      rerenderWith(payloadFor({ storyId: 2, src: "https://cdn.test/uploads/second.mp4" }), {
        itemId: "item-2",
      });
    });

    const second = video()!;
    expect(second).not.toBe(first);

    // Everything the old element does from here belongs to a story we have left.
    await act(async () => {
      await firstMedia.rejectPlay("NotAllowedError");
      firstMedia.set({ currentTime: 9 });
      firstMedia.emit("playing");
      firstMedia.emit("ended");
      jest.advanceTimersByTime(1000);
    });

    expect(next).not.toHaveBeenCalled();
    expect(progress()).toBe(0);
    expect(screen.queryByTestId("story-media-error")).not.toBeInTheDocument();
  });

  it("pauses and mutes the outgoing video when the story changes", async () => {
    const { video, rerenderWith } = renderSurface(payloadFor(), { itemId: "item-1" });
    const first = video()!;
    const firstMedia = controlMedia(first);
    await reachPlaying(firstMedia);

    const pausesBefore = firstMedia.state().pauseCalls;
    await act(async () => {
      rerenderWith(payloadFor({ storyId: 2 }), { itemId: "item-2" });
    });

    expect(firstMedia.state().pauseCalls).toBeGreaterThan(pausesBefore);
    expect(first.muted).toBe(true);
  });

  it("freezes progress and pauses the element while the viewer is held", async () => {
    const { video, progress, rerenderWith } = renderSurface(payloadFor());
    const media = controlMedia(video()!);
    await reachPlaying(media, { durationSeconds: 10 });

    media.set({ currentTime: 2 });
    await flushProgress();
    expect(progress()).toBeCloseTo(0.2, 2);

    const pausesBefore = media.state().pauseCalls;
    await act(async () => {
      rerenderWith(payloadFor(), { isPaused: true });
    });
    expect(media.state().pauseCalls).toBeGreaterThan(pausesBefore);

    // currentTime cannot move while paused, and neither may the bar.
    await flushProgress(3000);
    expect(progress()).toBeCloseTo(0.2, 2);
  });

  it("pauses when the tab is hidden and does not complete the story meanwhile", async () => {
    const { video, next, progress } = renderSurface(payloadFor());
    const media = controlMedia(video()!);
    await reachPlaying(media, { durationSeconds: 10 });
    media.set({ currentTime: 1 });
    await flushProgress();

    const pausesBefore = media.state().pauseCalls;
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(media.state().pauseCalls).toBeGreaterThan(pausesBefore);
    await flushProgress(20_000);
    expect(next).not.toHaveBeenCalled();
    expect(progress()).toBeCloseTo(0.1, 2);

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(media.state().paused).toBe(false);
  });

  it("mounts no player at all on a story that is not the live one", async () => {
    const { video } = renderSurface(payloadFor(), { isActive: false });
    // Cube neighbours used to mount and autoplay their own video on every navigation.
    expect(video()).toBeNull();
    expect(document.querySelector(`img[src="${POSTER_SRC}"]`)).toBeInTheDocument();
  });
});

describe("StoryMediaSurface — images and text", () => {
  it("runs an image story on its configured duration and advances once", async () => {
    const { next, progress, view } = renderSurface(
      payloadFor({ kind: "image", src: "https://cdn.test/uploads/a.webp", poster: undefined, durationMs: 4000 }),
    );
    expect(view.container.querySelector("video")).toBeNull();

    const image = view.container.querySelector("img")!;
    await act(async () => {
      fireEvent.load(image);
    });

    await flushProgress(2000);
    expect(progress()).toBeGreaterThan(0.4);
    expect(progress()).toBeLessThan(0.6);
    expect(next).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(2200);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps an image story frozen until it has actually loaded", async () => {
    const { progress, next } = renderSurface(
      payloadFor({ kind: "image", src: "https://cdn.test/uploads/a.webp", poster: undefined, durationMs: 2000 }),
    );
    await flushProgress(5000);
    expect(progress()).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });

  it("renders the unavailable text card without any media element", async () => {
    const { view, next } = renderSurface(
      payloadFor({ kind: "text", src: "", poster: undefined, text: "Story unavailable", durationMs: 2000 }),
    );
    expect(view.container.querySelector("video")).toBeNull();
    expect(screen.getByText("Story unavailable")).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(2200);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
