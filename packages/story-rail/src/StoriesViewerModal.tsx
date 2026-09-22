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
import type {
  StoriesViewerModalProps,
  StoryRailItem,
  StoryRailStory,
  StoryViewerLabels,
} from "./types";
import {
  firstUnseenItemIndex,
  getStoryItems,
  hasUsableMediaUrl,
  isImageStory,
  isVideoStory,
} from "./story-utils";
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

const DEFAULT_LABELS: StoryViewerLabels = {
  dialog: (title) => `Stories by ${title}`,
  close: "Close story viewer",
  description:
    "Story viewer. Use the left and right sides or arrow keys to navigate. Press Escape to close.",
  progress: (percent) => `Story progress: ${percent}%`,
  announcement: (current, total, title) => `Viewing story ${current} of ${total} by ${title}`,
  mediaFailure: "This story cannot be played in this browser.",
  retry: "Try again",
  mute: "Mute",
  unmute: "Play sound",
};

function getStaticAvatarUrl(
  story: StoryRailStory,
  resolveMediaUrl: (url: string) => string,
): string {
  if (story.Thumbnail?.url) return resolveMediaUrl(story.Thumbnail.url);
  const items = getStoryItems(story);
  const itemThumbnail = items.find((item) => item.Thumbnail?.url)?.Thumbnail?.url;
  if (itemThumbnail) return resolveMediaUrl(itemThumbnail);
  const image = items.find(isImageStory);
  if (image?.Media?.url) return resolveMediaUrl(image.Media.url);
  return FALLBACK_AVATAR_URL;
}

function getStoryItemId(story: StoryRailStory, item: StoryRailItem): string {
  const mediaKey = item.Media?.id ?? item.Media?.url ?? "missing-media";
  return `story-${story.id}-${item.Key}-${item.MediaType}-${mediaKey}`;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), length - 1);
}

function toPayload(
  story: StoryRailStory,
  item: StoryRailItem,
  resolveMediaUrl: (url: string) => string,
  unavailableText: string,
  labels: StoryViewerLabels,
): StoryMediaPayload {
  const mediaUrl = hasUsableMediaUrl(item.Media?.url) ? resolveMediaUrl(item.Media.url) : "";
  const poster = item.Thumbnail?.url ? resolveMediaUrl(item.Thumbnail.url) : undefined;
  const kind: StoryMediaPayload["kind"] = !mediaUrl
    ? "text"
    : isVideoStory(item)
      ? "video"
      : isImageStory(item)
        ? "image"
        : "text";
  return {
    storyId: story.id,
    itemKey: item.Key,
    kind,
    src: mediaUrl,
    poster,
    title: story.Title,
    durationMs:
      Number.isFinite(item.DurationMs) && item.DurationMs > 0 ? item.DurationMs : 5000,
    text: kind === "text" ? story.Title || unavailableText : undefined,
    ctaUrl: item.CtaUrl,
    overlays: item.Overlays?.map((overlay) => ({
      ...overlay,
      ...(overlay.imageUrl ? { imageUrl: resolveMediaUrl(overlay.imageUrl) } : {}),
    })),
    labels: {
      mediaFailure: labels.mediaFailure,
      retry: labels.retry,
      mute: labels.mute,
      unmute: labels.unmute,
    },
  };
}

export function storiesToUsers<TStory extends StoryRailStory>({
  stories,
  resolveMediaUrl,
  unavailableText,
  labels = DEFAULT_LABELS,
}: {
  stories: TStory[];
  resolveMediaUrl: (url: string) => string;
  unavailableText: string;
  labels?: StoryViewerLabels;
}): User[] {
  return stories.map((story) => ({
    id: String(story.id),
    username: story.Title,
    avatarUrl: getStaticAvatarUrl(story, resolveMediaUrl),
    hasUnreadStories: false,
    stories: getStoryItems(story).map((item) => ({
      id: getStoryItemId(story, item),
      type: "custom_component" as const,
      component: StoryMediaSurface,
      duration: item.DurationMs,
      metadata: toPayload(story, item, resolveMediaUrl, unavailableText, labels),
    })),
  }));
}

function prefetchTargetFor(item: User["stories"][number] | undefined): PrefetchTarget | undefined {
  const payload = item?.metadata as StoryMediaPayload | undefined;
  if (!payload) return undefined;
  return {
    posterUrl: payload.poster ?? (payload.kind === "image" ? payload.src : undefined),
    videoUrl: payload.kind === "video" ? payload.src : undefined,
  };
}

function adjacentItems(users: User[], userIndex: number, itemIndex: number) {
  const current = users[userIndex];
  const nextInStory = current?.stories[itemIndex + 1];
  const nextStoryFirst = users[userIndex + 1]?.stories[0];
  const previousInStory = current?.stories[itemIndex - 1];
  const previousUser = users[userIndex - 1];
  return {
    next: nextInStory ?? nextStoryFirst,
    // When the immediate target is another item in this story, also warm the first
    // item in the next group. Never walk farther through a 20-item story.
    afterNext: nextInStory ? nextStoryFirst : undefined,
    previous: previousInStory ?? previousUser?.stories[previousUser.stories.length - 1],
  };
}

function reportStoryMediaIssue(issue: StoryMediaIssue): void {
  const sentry = (globalThis as { Sentry?: { captureMessage?: (m: string, c?: unknown) => void } })
    .Sentry;
  if (sentry?.captureMessage) {
    sentry.captureMessage("story-media-failure", { level: "warning", extra: issue });
    return;
  }
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (env?.env?.NODE_ENV !== "production") console.warn("[story-rail] media failure", issue);
}

export function StoriesViewerModal<TStory extends StoryRailStory = StoryRailStory>({
  stories,
  seenIds = new Set<number>(),
  seenItems,
  isOpen,
  initialIndex,
  onClose,
  onStoryView,
  resolveMediaUrl,
  unavailableText = "Story unavailable",
  classNames,
  dir = "rtl",
  labels = DEFAULT_LABELS,
}: StoriesViewerModalProps<TStory>) {
  const users = useMemo(
    () => storiesToUsers({ stories, resolveMediaUrl, unavailableText, labels }),
    [stories, resolveMediaUrl, unavailableText, labels],
  );
  const safeInitialIndex = useMemo(
    () => clampIndex(initialIndex, users.length),
    [initialIndex, users.length],
  );
  const initialItemIndex = useMemo(
    () => firstUnseenItemIndex(stories[safeInitialIndex], seenItems),
    [safeInitialIndex, seenItems, stories],
  );
  // Seen-state updates arrive immediately after an item becomes active. Keep the
  // opening target fixed for this viewer session; otherwise every write changes the
  // upstream component key and remounts at the next unseen item, cascading through a
  // whole multi-item story without user navigation.
  const openingRef = useRef({
    isOpen: false,
    userIndex: safeInitialIndex,
    itemIndex: initialItemIndex,
  });
  if (isOpen && !openingRef.current.isOpen) {
    openingRef.current = {
      isOpen: true,
      userIndex: safeInitialIndex,
      itemIndex: initialItemIndex,
    };
  } else if (!isOpen && openingRef.current.isOpen) {
    openingRef.current = { ...openingRef.current, isOpen: false };
  }
  const openingUserIndex = openingRef.current.userIndex;
  const openingItemIndex = openingRef.current.itemIndex;

  const storeRef = useRef<StoryPlaybackStore | null>(null);
  if (storeRef.current === null) storeRef.current = createPlaybackStore(reportStoryMediaIssue);
  const store = storeRef.current;

  const [activeUserIndex, setActiveUserIndex] = useState(openingUserIndex);
  const [activeItemIndex, setActiveItemIndex] = useState(openingItemIndex);
  const reportedRef = useRef(new Set<string>());
  const storiesRef = useRef(stories);
  const seenItemsRef = useRef(seenItems);
  const seenIdsRef = useRef(seenIds);
  const onStoryViewRef = useRef(onStoryView);

  useLayoutEffect(() => {
    storiesRef.current = stories;
    seenItemsRef.current = seenItems;
    seenIdsRef.current = seenIds;
    onStoryViewRef.current = onStoryView;
  }, [stories, seenItems, seenIds, onStoryView]);

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const activeItemId = users[activeUserIndex]?.stories[activeItemIndex]?.id;
  const progress = snapshot.itemId === activeItemId ? snapshot.progress : 0;
  const adjacent = useMemo(
    () => adjacentItems(users, activeUserIndex, activeItemIndex),
    [users, activeUserIndex, activeItemIndex],
  );
  useMediaPrefetch({
    next: prefetchTargetFor(adjacent.next),
    afterNext: prefetchTargetFor(adjacent.afterNext),
    previous: prefetchTargetFor(adjacent.previous),
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  const handleStoryChange = useCallback((userIndex: number, itemIndex: number) => {
    setActiveUserIndex(userIndex);
    setActiveItemIndex(itemIndex);
    const story = storiesRef.current[userIndex];
    const item = story ? getStoryItems(story)[itemIndex] : undefined;
    if (!story || !item) return;
    const reportKey = `${story.id}:${item.Key}`;
    if (reportedRef.current.has(reportKey)) return;
    reportedRef.current.add(reportKey);
    const alreadySeen = seenItemsRef.current
      ? seenItemsRef.current.get(story.id)?.has(item.Key)
      : seenIdsRef.current.has(story.id);
    if (!alreadySeen) onStoryViewRef.current(story.id, item.Key);
  }, []);

  if (!isOpen) return null;

  return (
    <StoryPlaybackContext.Provider value={store}>
      <LibStoryViewer
        key={`${users[openingUserIndex]?.id ?? "empty"}-${openingUserIndex}-${openingItemIndex}`}
        users={users}
        isOpen={isOpen}
        initialUserIndex={openingUserIndex}
        initialStoryIndex={openingItemIndex}
        onClose={onClose}
        onStoryChange={handleStoryChange}
        progress={progress}
        dir={dir}
        labels={labels}
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
