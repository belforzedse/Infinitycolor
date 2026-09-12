import React from "react";
import { act, render, screen } from "@testing-library/react";
import { StoriesViewerModal } from "../StoriesViewerModal";
import type { StoryRailStory } from "../types";
import { controlMedia, installMediaStub, uninstallMediaStub } from "./media-stub";

/**
 * These exercise the boundary with the patched package (see patches/README.md): that our
 * progress actually drives the bar, that the package's inert timer never advances a story
 * behind our back, that a custom renderer is told whether it is the live face, and that
 * closing the viewer releases the body scroll lock.
 */

const IMAGE_STORY: StoryRailStory = {
  id: 1,
  Title: "تصویر",
  MediaType: "image",
  Media: { id: 11, url: "/uploads/one.webp", mime: "image/webp" },
  DurationMs: 4000,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const VIDEO_STORY: StoryRailStory = {
  id: 2,
  Title: "ویدیو",
  MediaType: "video",
  Media: { id: 22, url: "/uploads/two.mp4", mime: "video/mp4" },
  Thumbnail: { id: 23, url: "/uploads/two-cover.webp", mime: "image/webp" },
  DurationMs: 3000,
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const resolveMediaUrl = (url: string) => `https://cdn.test${url}`;

function renderViewer(
  stories: StoryRailStory[] = [IMAGE_STORY, VIDEO_STORY],
  overrides: { initialIndex?: number; seenIds?: Set<number> } = {},
) {
  const onClose = jest.fn();
  const onStoryView = jest.fn();
  const view = render(
    <StoriesViewerModal
      stories={stories}
      seenIds={overrides.seenIds ?? new Set()}
      isOpen
      initialIndex={overrides.initialIndex ?? 0}
      onClose={onClose}
      onStoryView={onStoryView}
      resolveMediaUrl={resolveMediaUrl}
      unavailableText="Story unavailable"
    />,
  );
  return { onClose, onStoryView, view };
}

function fillScale(): number {
  const fill = document.querySelector(".story-progress-bar-fill") as HTMLElement | null;
  const match = /scaleX\(([\d.]+)\)/.exec(fill?.style.transform ?? "");
  return match ? Number(match[1]) : Number.NaN;
}

beforeEach(() => {
  installMediaStub();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  uninstallMediaStub();
  document.body.style.overflow = "";
  jest.clearAllMocks();
});

describe("StoriesViewerModal", () => {
  it("presents the first story immediately, with no fixed opening delay", () => {
    renderViewer();
    // Upstream gated every open behind a hardcoded 1500ms spinner; the story must be on
    // screen as soon as the viewer mounts.
    expect(screen.getByTestId("story-media-surface")).toBeInTheDocument();
    expect(fillScale()).toBe(0);
  });

  it("drives the package progress bar from real playback, not a wall clock", async () => {
    renderViewer([VIDEO_STORY]);
    const media = controlMedia(document.querySelector("video")!);

    // Time passing on its own must not move the bar: upstream's timer would have.
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(fillScale()).toBe(0);

    await act(async () => {
      media.set({ readyState: 4, duration: 10, videoWidth: 1080, videoHeight: 1920 });
      media.emit("loadedmetadata");
      media.emit("canplay");
      await media.resolvePlay();
    });
    await act(async () => {
      media.emit("playing");
    });
    media.set({ currentTime: 4 });
    await act(async () => {
      jest.advanceTimersByTime(200);
    });

    // 4s of the real 10s duration — not of the story's declared 3000ms.
    expect(fillScale()).toBeCloseTo(0.4, 2);
  });

  it("does not advance a story on its own while media is still loading", async () => {
    const { onStoryView } = renderViewer([VIDEO_STORY, IMAGE_STORY], { initialIndex: 0 });

    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });

    // The package's own timer is inert, so a story with unloadable media stays put
    // instead of being skipped past after its nominal duration.
    expect(onStoryView).toHaveBeenCalledTimes(1);
    expect(onStoryView).toHaveBeenCalledWith(VIDEO_STORY.id);
  });

  it("reports each story view exactly once", async () => {
    const { onStoryView } = renderViewer();
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(onStoryView).toHaveBeenCalledTimes(1);
    expect(onStoryView).toHaveBeenCalledWith(IMAGE_STORY.id);
  });

  it("does not re-report a story the caller already knows is seen", async () => {
    const { onStoryView } = renderViewer([IMAGE_STORY, VIDEO_STORY], {
      seenIds: new Set([IMAGE_STORY.id]),
    });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(onStoryView).not.toHaveBeenCalled();
  });

  it("locks body scroll while open and releases it on close", () => {
    const { view } = renderViewer();
    expect(document.body.style.overflow).toBe("hidden");

    // Upstream applied the lock inside an uncleared 1500ms timeout, so closing quickly
    // left the page permanently unscrollable.
    view.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("pauses and mutes the video when the viewer closes", async () => {
    const { view } = renderViewer([VIDEO_STORY]);
    const element = document.querySelector("video")!;
    const media = controlMedia(element);

    await act(async () => {
      media.set({ readyState: 4, duration: 5, videoWidth: 1080, videoHeight: 1920 });
      media.emit("canplay");
      await media.resolvePlay();
    });
    await act(async () => {
      media.emit("playing");
    });

    const pausesBefore = media.state().pauseCalls;
    await act(async () => {
      view.unmount();
    });

    expect(media.state().pauseCalls).toBeGreaterThan(pausesBefore);
    expect(element.muted).toBe(true);
  });

  it("starts a reopened viewer from a clean state", async () => {
    const first = renderViewer([VIDEO_STORY]);
    const media = controlMedia(document.querySelector("video")!);
    await act(async () => {
      media.set({ readyState: 4, duration: 10, videoWidth: 1080, videoHeight: 1920 });
      media.emit("loadedmetadata");
      media.emit("canplay");
      await media.resolvePlay();
    });
    await act(async () => {
      media.emit("playing");
    });
    media.set({ currentTime: 8 });
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(fillScale()).toBeCloseTo(0.8, 2);

    await act(async () => {
      first.view.unmount();
    });

    renderViewer([VIDEO_STORY]);
    // No inherited progress, no inherited timer, and a fresh element at time zero.
    expect(fillScale()).toBe(0);
    expect(document.querySelector("video")!.currentTime).toBe(0);
  });

  it("renders a text card for a story whose media URL was rejected", () => {
    // `resolveMediaUrl` returns "" for anything it will not trust. That must degrade to
    // the existing text card — never to a <video src=""> that errors instantly and skips.
    renderViewer([{ ...IMAGE_STORY, Media: { id: 99, url: "", mime: "image/webp" } }]);
    // The title also appears in the viewer header, so scope to the media surface.
    expect(screen.getByTestId("story-media-surface")).toHaveTextContent(IMAGE_STORY.Title);
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("img[src^='https://cdn.test']")).toBeNull();
  });

  it("falls back to the unavailable copy when such a story has no title either", () => {
    renderViewer([{ ...IMAGE_STORY, Title: "", Media: { id: 99, url: "", mime: "image/webp" } }]);
    expect(screen.getByText("Story unavailable")).toBeInTheDocument();
  });
});
