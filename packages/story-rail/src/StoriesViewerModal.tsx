"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { StoryViewer as LibStoryViewer } from "react-instagram-stories";
import type { User } from "react-instagram-stories";
import type { StoriesViewerModalProps, StoryRailStory } from "./types";
import { hasUsableMediaUrl, isImageStory, isVideoStory } from "./story-utils";
import { StoryMediaSurface, type StoryMediaPayload } from "./media/StoryMediaSurface";
import {
  StoryPlaybackContext,
  createPlaybackStore,
  type StoryMediaIssue,
  type StoryPlaybackStore,
} from "./media/playback-store";
import { useMediaPrefetch, type PrefetchTarget } from "./media/useMediaPrefetch";

const FALLBACK_AVATAR_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

/**
 * The package's own wall-clock timer is inert here (patches/README.md, edit E2): this
 * modal supplies `progress`, and `StoryMediaSurface` owns readiness, playback and the
 * decision to advance. `duration` is therefore never read by the package; it is kept on
 * the item only so the payload stays self-describing.
 */

function getStaticAvatarUrl(
  story: StoryRailStory,
  resolveMediaUrl: (url: string) => string,
): string {
  if (story.Thumbnail?.url) return resolveMediaUrl(story.Thumbnail.url);
  if (isImageStory(story) && story.Media?.url) return resolveMediaUrl(story.Media.url);
  return FALLBACK_AVATAR_URL;
}

function getStoryItemId(story: StoryRailStory): string {
  const mediaKey = story.Media?.id ?? story.Media?.url ?? "missing-media";
  const timestampKey = story.updatedAt || story.createdAt || "unknown-time";
  return `story-${story.id}-${story.MediaType}-${mediaKey}-${timestampKey}`;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), length - 1);
}

function toPayload({
  story,
  resolveMediaUrl,
  unavailableText,
}: {
  story: StoryRailStory;
  resolveMediaUrl: (url: string) => string;
  unavailableText: string;
}): StoryMediaPayload {
  const mediaUrl = hasUsableMediaUrl(story.Media?.url) ? resolveMediaUrl(story.Media.url) : "";
  const poster = story.Thumbnail?.url ? resolveMediaUrl(story.Thumbnail.url) : undefined;
  // `resolveMediaUrl` returns "" for anything it will not trust, so a story whose media is
  // rejected must degrade to the text card rather than mount a <video src="">.
  const kind: StoryMediaPayload["kind"] = !mediaUrl
    ? "text"
    : isVideoStory(story)
      ? "video"
      : isImageStory(story)
        ? "image"
        : "text";

  return {
    storyId: story.id,
    kind,
    src: mediaUrl,
    poster,
    title: story.Title,
    durationMs: Number.isFinite(story.DurationMs) && story.DurationMs > 0 ? story.DurationMs : 5000,
    text: kind === "text" ? story.Title || unavailableText : undefined,
  };
}

function storiesToUsers<TStory extends StoryRailStory>({
  stories,
  resolveMediaUrl,
  unavailableText,
}: {
  stories: TStory[];
  resolveMediaUrl: (url: string) => string;
  unavailableText: string;
}): User[] {
  return stories.map((story) => ({
    id: String(story.id),
    username: story.Title,
    avatarUrl: getStaticAvatarUrl(story, resolveMediaUrl),
    hasUnreadStories: false,
    stories: [
      {
        id: getStoryItemId(story),
        type: "custom_component" as const,
        // One stable module-level component type for every story. Building a component
        // per render (as this used to) makes React unmount and remount the player on any
        // parent re-render, restarting playback from zero.
        component: StoryMediaSurface,
        duration: story.DurationMs,
        metadata: toPayload({ story, resolveMediaUrl, unavailableText }),
      },
    ],
  }));
}

function prefetchTargetFor(user: User | undefined): PrefetchTarget | undefined {
  const payload = user?.stories[0]?.metadata as StoryMediaPayload | undefined;
  if (!payload) return undefined;
  return {
    posterUrl: payload.poster ?? (payload.kind === "image" ? payload.src : undefined),
    videoUrl: payload.kind === "video" ? payload.src : undefined,
  };
}

function reportStoryMediaIssue(issue: StoryMediaIssue): void {
  // Structured, low-volume, and free of query strings (which can carry signed tokens).
  // Sentry is picked up when the host app has installed it; otherwise this is a dev-only
  // console line, so production logs stay quiet.
  const sentry = (globalThis as { Sentry?: { captureMessage?: (m: string, c?: unknown) => void } })
    .Sentry;
  if (sentry?.captureMessage) {
    sentry.captureMessage("story-media-failure", { level: "warning", extra: issue });
    return;
  }
  // `process` is not declared in this package's lib set; read it defensively so the
  // warning stays a development-only aid and never trips a bundler or SSR pass.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (env?.env?.NODE_ENV !== "production") {
    console.warn("[story-rail] media failure", issue);
  }
}

export function StoriesViewerModal<TStory extends StoryRailStory = StoryRailStory>({
  stories,
  seenIds,
  isOpen,
  initialIndex,
  onClose,
  onStoryView,
  resolveMediaUrl,
  unavailableText = "Story unavailable",
  classNames,
}: StoriesViewerModalProps<TStory>) {
  const users = useMemo(
    () => storiesToUsers({ stories, resolveMediaUrl, unavailableText }),
    [stories, resolveMediaUrl, unavailableText],
  );
  const safeInitialIndex = useMemo(
    () => clampIndex(initialIndex, users.length),
    [initialIndex, users.length],
  );

  // One store per mount: two rails can be on screen at once, so a module global would
  // let one viewer's progress drive the other's bar.
  const storeRef = useRef<StoryPlaybackStore | null>(null);
  if (storeRef.current === null) storeRef.current = createPlaybackStore(reportStoryMediaIssue);
  const store = storeRef.current;

  const [activeIndex, setActiveIndex] = useState(safeInitialIndex);
  const lastStoryIdRef = useRef<number | null>(null);
  const storiesRef = useRef(stories);
  const seenIdsRef = useRef(seenIds);
  const onStoryViewRef = useRef(onStoryView);

  useLayoutEffect(() => {
    storiesRef.current = stories;
    seenIdsRef.current = seenIds;
    onStoryViewRef.current = onStoryView;
  }, [stories, seenIds, onStoryView]);

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const activeItemId = users[activeIndex]?.stories[0]?.id;
  // Only the live story's progress may drive the bar; a publish left over from the story
  // we just left would otherwise show as a part-filled bar on the new one.
  const progress = snapshot.itemId === activeItemId ? snapshot.progress : 0;

  useMediaPrefetch({
    next: prefetchTargetFor(users[activeIndex + 1]),
    afterNext: prefetchTargetFor(users[activeIndex + 2]),
    previous: prefetchTargetFor(users[activeIndex - 1]),
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  const handleStoryChange = useCallback((userIndex: number) => {
    setActiveIndex(userIndex);
    const story = storiesRef.current[userIndex];
    if (!story) return;

    if (lastStoryIdRef.current === story.id) return;
    lastStoryIdRef.current = story.id;

    if (!seenIdsRef.current.has(story.id)) {
      onStoryViewRef.current(story.id);
    }
  }, []);

  if (!isOpen) return null;

  return (
    <StoryPlaybackContext.Provider value={store}>
      <LibStoryViewer
        key={`${users[safeInitialIndex]?.id ?? "empty"}-${safeInitialIndex}`}
        users={users}
        isOpen={isOpen}
        initialUserIndex={safeInitialIndex}
        initialStoryIndex={0}
        onClose={onClose}
        onStoryChange={handleStoryChange}
        progress={progress}
        classNames={{
          overlay: classNames?.overlay ?? "bg-black/95",
          progressBars: {
            bar: {
              fill:
                classNames?.progressFill ??
                "bg-gradient-to-r from-infinity-primary-light to-infinity-primary",
            },
          },
        }}
      />
    </StoryPlaybackContext.Provider>
  );
}

export default StoriesViewerModal;
