"use client";

import { createContext, useContext } from "react";
import type { MediaFailureKind } from "./playback-machine";

/**
 * The channel from the active media renderer back up to the modal.
 *
 * The renderer is instantiated by the package (as a `custom_component`), not by us, so
 * it cannot be handed callbacks as props. React context does cross `createPortal`, so a
 * context-published store is enough and avoids module-level globals — which matters
 * because two rails can be mounted at once (storefront home + a post page).
 *
 * Progress is published through a subscription rather than React state so the renderer
 * can sample at animation rate while the modal re-renders at a throttled rate.
 */

export interface StoryPlaybackSnapshot {
  /** 0..1 for the live story. */
  progress: number;
  /** Story item id the progress belongs to, so a stale publish can be discarded. */
  itemId: string | null;
  /**
   * Item id of the live story once it has enough buffered (or is an image/text) that
   * warming the next video will not starve it. Compared with the active id by the modal.
   */
  readyForNext: string | null;
}

export interface StoryAudioPreference {
  enabled: boolean;
  set(enabled: boolean): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): boolean;
}

export interface StoryPlaybackStore {
  publishProgress(itemId: string, progress: number): void;
  publishReadyForNext(itemId: string): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): StoryPlaybackSnapshot;
  audio: StoryAudioPreference;
  reportIssue(report: StoryMediaIssue): void;
}

export interface StoryMediaIssue {
  storyId: number | string;
  mediaType: "image" | "video" | "text";
  /** Host + path only — never the query string, which can carry signed tokens. */
  mediaHost: string;
  mediaPath: string;
  failure: MediaFailureKind;
  /** HTMLMediaElement.error.code, when the browser supplied one. */
  mediaErrorCode: number | null;
  videoEngine?: "mp4" | "webm" | "native-hls" | "hls.js";
  attemptedEngines?: string[];
  playback?: import("@repo/video-player").PlaybackDiagnostics;
}

export type StoryMediaIssueReporter = (issue: StoryMediaIssue) => void;

/**
 * Sound is off for the first story and then stays wherever the viewer last put it.
 * Browsers refuse unattended autoplay with audio, so a story that started unmuted would
 * simply never play. The preference lives outside React state because the viewer builds
 * a fresh element per story, which would otherwise reset the choice on every advance.
 */
export function createAudioPreference(): StoryAudioPreference {
  const listeners = new Set<() => void>();
  let enabled = false;
  return {
    get enabled() {
      return enabled;
    },
    set(next: boolean) {
      if (enabled === next) return;
      enabled = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return enabled;
    },
  };
}

export function createPlaybackStore(
  reportIssue?: StoryMediaIssueReporter,
): StoryPlaybackStore {
  const listeners = new Set<() => void>();
  let snapshot: StoryPlaybackSnapshot = {
    progress: 0,
    itemId: null,
    readyForNext: null,
  };

  return {
    publishProgress(itemId: string, progress: number) {
      if (snapshot.itemId === itemId && snapshot.progress === progress) return;
      snapshot = { ...snapshot, itemId, progress };
      listeners.forEach((listener) => listener());
    },
    publishReadyForNext(itemId: string) {
      if (snapshot.readyForNext === itemId) return;
      snapshot = { ...snapshot, readyForNext: itemId };
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    audio: createAudioPreference(),
    reportIssue(issue: StoryMediaIssue) {
      reportIssue?.(issue);
    },
  };
}

export const StoryPlaybackContext = createContext<StoryPlaybackStore | null>(
  null,
);

export function useStoryPlaybackStore(): StoryPlaybackStore | null {
  return useContext(StoryPlaybackContext);
}

/** Splits a resolved media URL into the parts that are safe to log. */
export function describeMediaUrl(url: string): {
  mediaHost: string;
  mediaPath: string;
} {
  try {
    const parsed = new URL(
      url,
      typeof window === "undefined" ? "http://localhost" : window.location.href,
    );
    return { mediaHost: parsed.host, mediaPath: parsed.pathname };
  } catch {
    return { mediaHost: "", mediaPath: "" };
  }
}
