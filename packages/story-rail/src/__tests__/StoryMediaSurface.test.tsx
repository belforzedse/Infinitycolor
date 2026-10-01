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
    itemKey: "item-1",
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
  options: { isActive?: boolean; isPaused?: boolean; itemId?: string; reportIssue?: Parameters<typeof createPlaybackStore>[0] } = {},
) {
  const next = jest.fn();
  const store = createPlaybackStore(options.reportIssue);
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
    nextOptions: {
      isActive?: boolean;
      isPaused?: boolean;
      itemId?: string;
    } = {},
  ) =>
    view.rerender(
      <StoryPlaybackContext.Provider value={store}>
        <StoryMediaSurface
          pause={noop}
          resume={noop}
          next={next}
          prev={noop}
          setDuration={noop}
          item={{
            id: nextOptions.itemId ?? options.itemId ?? "item-1",
            metadata: nextPayload,
          }}
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
    media.set({
      readyState: 4,
      duration: durationSeconds,
      videoWidth: 1080,
      videoHeight: 1920,
    });
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
      media.set({
        readyState: 4,
        duration: 10,
        videoWidth: 1080,
        videoHeight: 1920,
      });
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

describe("StoryMediaSurface — engine behaviour", () => {
  it("leaves buffering once time moves again, even without a new `playing` event", async () => {
    const { video, progress } = renderSurface(payloadFor());
    const media = controlMedia(video()!);
    await reachPlaying(media, { durationSeconds: 10 });

    media.set({ currentTime: 2 });
    await act(async () => {
      media.emit("timeupdate");
      media.emit("waiting");
    });
    expect(screen.getByTestId("story-media-surface")).toHaveAttribute("data-phase", "buffering");

    // Playback carried on from buffer: time moves, but the browser sends no `playing`.
    await act(async () => {
      media.set({ currentTime: 2.5 });
      media.emit("timeupdate");
    });
    expect(screen.getByTestId("story-media-surface")).toHaveAttribute("data-phase", "playing");
    media.set({ currentTime: 5 });
    await flushProgress();
    expect(progress()).toBeCloseTo(0.5, 2);
  });

  it("does not freeze on a `stalled` network event while playback continues", async () => {
    const { video } = renderSurface(payloadFor());
    const media = controlMedia(video()!);
    await reachPlaying(media);
    await act(async () => {
      media.emit("stalled");
    });
    expect(screen.getByTestId("story-media-surface")).toHaveAttribute("data-phase", "playing");
  });

  it("keeps the poster over the video until a frame is actually presented", async () => {
    const { video, view } = renderSurface(payloadFor());
    const media = controlMedia(video()!);
    const poster = () => view.container.querySelector('img[aria-hidden="true"]') as HTMLImageElement;
    await act(async () => {
      media.set({ readyState: 4, duration: 5, videoWidth: 1080, videoHeight: 1920 });
      media.emit("canplay");
      await media.resolvePlay();
      media.emit("playing");
    });
    // `playing` alone is not a frame on screen.
    expect(poster()).toHaveStyle({ opacity: "1" });
    await act(async () => {
      media.set({ currentTime: 0.04 });
      media.emit("timeupdate");
    });
    expect(poster()).toHaveStyle({ opacity: "0" });
    // The poster sits above the video in paint order.
    const children = Array.from(screen.getByTestId("story-media-surface").children);
    expect(children.indexOf(poster())).toBeGreaterThan(children.indexOf(video()!));
  });

  it("brings the poster back when the face goes inactive, so a cube turn never shows black", async () => {
    const payload = payloadFor();
    const { video, view, rerenderWith } = renderSurface(payload);
    const media = controlMedia(video()!);
    const poster = () => view.container.querySelector('img[aria-hidden="true"]') as HTMLImageElement;
    await act(async () => {
      media.set({ readyState: 4, duration: 5, videoWidth: 1080, videoHeight: 1920 });
      media.emit("canplay");
      await media.resolvePlay();
      media.emit("playing");
      media.set({ currentTime: 0.04 });
      media.emit("timeupdate");
    });
    expect(poster()).toHaveStyle({ opacity: "0" });

    // The viewer moved on: this face is still on screen while it rotates away.
    await act(async () => {
      rerenderWith(payload, { isActive: false });
    });
    expect(video()).toBeNull();
    expect(poster()).toHaveStyle({ opacity: "1" });

    // Coming back gets a fresh element, and the poster holds until that one presents.
    await act(async () => {
      rerenderWith(payload, { isActive: true });
    });
    expect(video()).not.toBeNull();
    expect(poster()).toHaveStyle({ opacity: "1" });
  });

  it("uses the media worker's generated poster when the story has no cover", async () => {
    const { view } = renderSurface(
      payloadFor({ poster: "https://cdn.test/uploads/clip_v1-0a1b2c3d.jpg", video: { mp4: VIDEO_SRC, poster: "https://cdn.test/uploads/clip_v1-0a1b2c3d.jpg" } }),
    );
    expect(view.container.querySelector('img[aria-hidden="true"]')).toHaveAttribute(
      "src",
      "https://cdn.test/uploads/clip_v1-0a1b2c3d.jpg",
    );
  });

  it("offers tap-to-play when even muted autoplay is refused, and starts inside the tap", async () => {
    const { video } = renderSurface(payloadFor());
    const element = video()!;
    const media = controlMedia(element);
    await act(async () => {
      element.muted = true;
      media.emit("canplay");
    });
    await act(async () => {
      await media.rejectPlay("NotAllowedError");
    });
    const button = screen.getByTestId("story-tap-to-play");
    const calls = media.playCalls();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(media.playCalls()).toBe(calls + 1);
    await act(async () => {
      await media.resolvePlay();
      media.emit("playing");
    });
    expect(screen.queryByTestId("story-tap-to-play")).not.toBeInTheDocument();
  });

  it("signals the viewer to warm the next story only once this one is buffered ahead", async () => {
    const { video, store } = renderSurface(payloadFor(), { itemId: "item-9" });
    const element = video()!;
    const media = controlMedia(element);
    await reachPlaying(media, { durationSeconds: 10 });
    const ranges = (end: number) => ({ length: 1, start: () => 0, end: () => end }) as unknown as TimeRanges;

    Object.defineProperty(element, "buffered", { configurable: true, get: () => ranges(2) });
    await act(async () => {
      media.emit("progress");
    });
    expect(store.getSnapshot().readyForNext).toBeNull();

    Object.defineProperty(element, "buffered", { configurable: true, get: () => ranges(5) });
    await act(async () => {
      media.emit("progress");
    });
    expect(store.getSnapshot().readyForNext).toBe("item-9");
  });
});

describe("StoryMediaSurface — autoplay", () => {
  it("still reports a final decode failure after an autoplay refusal", async () => {
    const reportIssue = jest.fn();
    const { video } = renderSurface(payloadFor(), { reportIssue });
    const media = controlMedia(video()!);
    await act(async () => {
      media.set({ duration: 5, readyState: 4, videoWidth: 720, videoHeight: 1280 }); media.emit("canplay");
      await media.rejectPlay("NotAllowedError");
    });
    await act(async () => { media.fail(3); });
    expect(reportIssue).toHaveBeenCalledWith(expect.objectContaining({ failure: "decode-unsupported" }));
    expect(reportIssue.mock.calls.filter(([issue]) => issue.failure === "decode-unsupported")).toHaveLength(1);
  });
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
      media.set({
        readyState: 4,
        duration: 5,
        videoWidth: 1080,
        videoHeight: 1920,
      });
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

describe("StoryMediaSurface — CTA", () => {
  it("renders the fixed Persian CTA for a safe storefront-relative destination", () => {
    renderSurface(
      payloadFor({
        kind: "image",
        src: "https://cdn.test/uploads/story.webp",
        ctaUrl: "/pdp/example?color=blue",
      }),
    );

    const link = screen.getByRole("link", { name: "مشاهده لینک" });
    expect(link).toHaveAttribute("href", "/pdp/example?color=blue");
    expect(link).not.toHaveAttribute("target");
  });

  it("opens a safe absolute CTA in a separate tab", () => {
    renderSurface(
      payloadFor({
        kind: "image",
        src: "https://cdn.test/uploads/story.webp",
        ctaUrl: "https://example.com/collection",
      }),
    );

    const link = screen.getByRole("link", { name: "مشاهده لینک" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it.each(["javascript:alert(1)", "//evil.example/path", "/\\evil.example/path"])(
    "does not render an unsafe CTA destination %s",
    (ctaUrl) => {
      renderSurface(
        payloadFor({
          kind: "image",
          src: "https://cdn.test/uploads/story.webp",
          ctaUrl,
        }),
      );

      expect(screen.queryByTestId("story-cta")).not.toBeInTheDocument();
    },
  );
});

describe("StoryMediaSurface — undecodable and broken media", () => {
  it("falls back to the cover image when the video track decodes no frames", async () => {
    // Production's HEVC-in-.mov: Chromium reports readyState 4, fires `playing` and
    // advances currentTime while decoding nothing, and never fires `error`.
    const { video, progress, next } = renderSurface(payloadFor({ durationMs: 4000 }));
    const media = controlMedia(video()!);

    await act(async () => {
      media.set({
        readyState: 4,
        duration: 10,
        videoWidth: 0,
        videoHeight: 0,
        totalVideoFrames: 0,
      });
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
      media.set({
        readyState: 4,
        duration: 10,
        videoWidth: 0,
        videoHeight: 0,
        totalVideoFrames: 0,
      });
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

    // One transient network error is retried in place by the playback engine...
    await act(async () => {
      media.fail(2); // MEDIA_ERR_NETWORK
    });
    expect(screen.queryByTestId("story-media-error")).not.toBeInTheDocument();
    // ...a second one is a dead story.
    await act(async () => {
      media.fail(2);
    });

    expect(screen.getByTestId("story-media-error")).toBeInTheDocument();
    expect(screen.queryByTestId("story-media-spinner")).not.toBeInTheDocument();
    // A dead story must not trap the viewer by auto-skipping or by blocking navigation.
    expect(next).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
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
            metadata: payloadFor({
              src: "https://cdn.test/uploads/a.mp4?token=SECRET",
              poster: undefined,
            }),
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
    const { video, next, progress, rerenderWith } = renderSurface(payloadFor(), {
      itemId: "item-1",
    });
    const first = video()!;
    const firstMedia = controlMedia(first);

    await act(async () => {
      firstMedia.set({
        readyState: 4,
        duration: 10,
        videoWidth: 1080,
        videoHeight: 1920,
      });
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
    const { video, rerenderWith } = renderSurface(payloadFor(), {
      itemId: "item-1",
    });
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
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(media.state().pauseCalls).toBeGreaterThan(pausesBefore);
    await flushProgress(20_000);
    expect(next).not.toHaveBeenCalled();
    expect(progress()).toBeCloseTo(0.1, 2);

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
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
      payloadFor({
        kind: "image",
        src: "https://cdn.test/uploads/a.webp",
        poster: undefined,
        durationMs: 4000,
      }),
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
      payloadFor({
        kind: "image",
        src: "https://cdn.test/uploads/a.webp",
        poster: undefined,
        durationMs: 2000,
      }),
    );
    await flushProgress(5000);
    expect(progress()).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });

  it("renders the unavailable text card without any media element", async () => {
    const { view, next } = renderSurface(
      payloadFor({
        kind: "text",
        src: "",
        poster: undefined,
        text: "Story unavailable",
        durationMs: 2000,
      }),
    );
    expect(view.container.querySelector("video")).toBeNull();
    expect(screen.getByText("Story unavailable")).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(2200);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
