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
import type { StoryItemControls, User } from "react-instagram-stories";
import type { StoriesViewerModalProps, StoryRailStory } from "./types";
import { hasUsableMediaUrl, isImageStory, isVideoStory } from "./story-utils";

const FALLBACK_AVATAR_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const VIDEO_LOADING_DURATION_MS = 10 * 60 * 1000;

/**
 * Sound is off for the first story and stays wherever the viewer last put it.
 *
 * Browsers refuse unattended autoplay with audio, so a story that started
 * unmuted would simply never play — which is why the element is muted at load
 * and only unmuted by an explicit tap. The preference lives outside React
 * because the viewer builds a fresh component per story item, so component
 * state would reset the choice on every advance.
 */
const storyAudio = {
  enabled: false,
  listeners: new Set<() => void>(),
  subscribe(listener: () => void): () => void {
    storyAudio.listeners.add(listener);
    return () => {
      storyAudio.listeners.delete(listener);
    };
  },
  getSnapshot(): boolean {
    return storyAudio.enabled;
  },
  set(enabled: boolean): void {
    if (storyAudio.enabled === enabled) return;
    storyAudio.enabled = enabled;
    storyAudio.listeners.forEach((listener) => listener());
  },
};

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

function getStaticAvatarUrl(story: StoryRailStory, resolveMediaUrl: (url: string) => string): string {
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

function cleanupVideo(video: HTMLVideoElement | null): void {
  if (!video) return;
  video.pause();
  try {
    video.currentTime = 0;
  } catch {
    // Some browsers reject currentTime changes before metadata is available.
  }
}

function createVideoStoryComponent({
  src,
  poster,
}: {
  src: string;
  poster?: string;
}): React.FC<StoryItemControls> {
  const VideoStory: React.FC<StoryItemControls> = (controls) => {
    const [isLoading, setIsLoading] = useState(true);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const controlsRef = useRef(controls);
    const loadStartedAtRef = useRef<number>(0);
    const hasAdvancedRef = useRef(false);
    const audioEnabled = useSyncExternalStore(
      storyAudio.subscribe,
      storyAudio.getSnapshot,
      () => false,
    );

    useLayoutEffect(() => {
      controlsRef.current = controls;
    }, [controls]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      let isMounted = true;
      const playVideo = () => {
        if (!isMounted) return;
        const playPromise = video.play();
        if (typeof playPromise?.catch === "function") {
          playPromise.catch(() => {
            // Playback with sound is refused until this tab has seen a gesture.
            // Drop back to muted so the story still plays instead of stalling.
            if (!isMounted || video.muted) return;
            video.muted = true;
            storyAudio.set(false);
            const retry = video.play();
            if (typeof retry?.catch === "function") retry.catch(() => undefined);
          });
        }
      };

      const handleLoadedMetadata = () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          const loadingElapsed = Date.now() - loadStartedAtRef.current;
          controlsRef.current.setDuration(loadingElapsed + video.duration * 1000);
        }
      };
      const handlePlayable = () => {
        setIsLoading(false);
        playVideo();
      };
      const handleEnded = () => {
        if (hasAdvancedRef.current) return;
        hasAdvancedRef.current = true;
        controlsRef.current.next();
      };
      const handleError = () => {
        if (hasAdvancedRef.current) return;
        hasAdvancedRef.current = true;
        setIsLoading(false);
        controlsRef.current.next();
      };

      loadStartedAtRef.current = Date.now();
      hasAdvancedRef.current = false;
      controlsRef.current.setDuration(VIDEO_LOADING_DURATION_MS);
      cleanupVideo(video);
      // Set imperatively rather than via the JSX prop: React does not apply the
      // `muted` attribute on first paint, which would make the initial autoplay
      // attempt an unmuted one and get it refused.
      video.muted = !storyAudio.getSnapshot();
      video.addEventListener("loadedmetadata", handleLoadedMetadata);
      video.addEventListener("loadeddata", handlePlayable);
      video.addEventListener("canplay", handlePlayable);
      video.addEventListener("canplaythrough", handlePlayable);
      video.addEventListener("playing", handlePlayable);
      video.addEventListener("ended", handleEnded);
      video.addEventListener("error", handleError);
      video.load();

      const playTimer = window.setTimeout(playVideo, 0);
      const stateTimer = window.setInterval(() => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          setIsLoading(false);
        }

        if (
          !hasAdvancedRef.current &&
          Number.isFinite(video.duration) &&
          video.duration > 0 &&
          video.currentTime >= video.duration - 0.1
        ) {
          hasAdvancedRef.current = true;
          controlsRef.current.next();
        }
      }, 500);

      return () => {
        isMounted = false;
        window.clearTimeout(playTimer);
        window.clearInterval(stateTimer);
        video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        video.removeEventListener("loadeddata", handlePlayable);
        video.removeEventListener("canplay", handlePlayable);
        video.removeEventListener("canplaythrough", handlePlayable);
        video.removeEventListener("playing", handlePlayable);
        video.removeEventListener("ended", handleEnded);
        video.removeEventListener("error", handleError);
        cleanupVideo(video);
      };
    }, []);

    const toggleAudio = (event: React.SyntheticEvent) => {
      // The viewer advances the story on taps anywhere over the surface, so the
      // toggle has to keep its own tap from reaching it.
      event.stopPropagation();
      event.preventDefault();
      const next = !storyAudio.getSnapshot();
      storyAudio.set(next);
      const video = videoRef.current;
      if (!video) return;
      video.muted = !next;
      if (next) {
        const playPromise = video.play();
        if (typeof playPromise?.catch === "function") playPromise.catch(() => undefined);
      }
    };

    const stopTap = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    return (
      <div className="relative flex h-full w-full items-center justify-center bg-black">
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          className="h-full w-full object-contain"
          playsInline
          autoPlay
          preload="auto"
          controls={false}
        />
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
          className="absolute bottom-6 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <SpeakerIcon muted={!audioEnabled} />
        </button>
        {isLoading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/35 border-t-white" />
          </div>
        ) : null}
      </div>
    );
  };

  VideoStory.displayName = "StoryVideo";
  return VideoStory;
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
  return stories.map((story) => {
    const mediaUrl = hasUsableMediaUrl(story.Media?.url) ? resolveMediaUrl(story.Media.url) : "";
    const storyItemId = getStoryItemId(story);
    const poster = story.Thumbnail?.url ? resolveMediaUrl(story.Thumbnail.url) : undefined;

    return {
      id: String(story.id),
      username: story.Title,
      avatarUrl: getStaticAvatarUrl(story, resolveMediaUrl),
      hasUnreadStories: false,
      stories: [
        isVideoStory(story)
          ? {
              id: storyItemId,
              type: "custom_component" as const,
              component: createVideoStoryComponent({ src: mediaUrl, poster }),
              duration: VIDEO_LOADING_DURATION_MS,
            }
          : isImageStory(story)
            ? {
                id: storyItemId,
                type: "image" as const,
                src: mediaUrl,
                alt: story.Title,
                duration: story.DurationMs,
              }
            : {
                id: storyItemId,
                type: "text" as const,
                text: story.Title || unavailableText,
                backgroundColor: "#111827",
                textColor: "#ffffff",
                duration: story.DurationMs,
              },
      ],
    };
  });
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
  const lastStoryIdRef = useRef<number | null>(null);
  const storiesRef = useRef(stories);
  const seenIdsRef = useRef(seenIds);
  const onStoryViewRef = useRef(onStoryView);

  useLayoutEffect(() => {
    storiesRef.current = stories;
    seenIdsRef.current = seenIds;
    onStoryViewRef.current = onStoryView;
  }, [stories, seenIds, onStoryView]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  const handleStoryChange = useCallback((userIndex: number) => {
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
    <LibStoryViewer
      key={`${users[safeInitialIndex]?.id ?? "empty"}-${safeInitialIndex}`}
      users={users}
      isOpen={isOpen}
      initialUserIndex={safeInitialIndex}
      initialStoryIndex={0}
      onClose={onClose}
      onStoryChange={handleStoryChange}
      classNames={{
        overlay: classNames?.overlay ?? "bg-black/95",
        progressBars: {
          bar: { fill: classNames?.progressFill ?? "bg-gradient-to-r from-infinity-primary-light to-infinity-primary" },
        },
      }}
    />
  );
}

export default StoriesViewerModal;
