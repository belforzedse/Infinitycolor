"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether post videos play with sound, for this tab session.
 *
 * Post videos autoplay muted (browsers refuse unattended audible autoplay). Once the
 * viewer turns sound on, the next post video they open should not silently revert — so
 * the choice is remembered, per tab, in one place that every post player reads. Stories
 * keep their own per-viewer preference and do not share this one.
 */
const KEY = "infinity.social.video-sound";
const listeners = new Set<() => void>();
let current: boolean | null = null;

function read(): boolean {
  if (current === null) {
    try {
      current = window.sessionStorage.getItem(KEY) === "1";
    } catch {
      current = false;
    }
  }
  return current;
}

function write(next: boolean): void {
  if (read() === next) return;
  current = next;
  try {
    window.sessionStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // Private mode: the in-memory value still covers this page.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useVideoSoundPreference(): [boolean, (next: boolean) => void] {
  const soundOn = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => write(next), []);
  return [soundOn, set];
}
