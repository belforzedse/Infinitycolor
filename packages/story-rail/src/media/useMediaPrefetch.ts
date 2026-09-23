"use client";

import { useEffect, useRef } from "react";
import { warmVideo, type VideoSource } from "@repo/video-player";

/**
 * Adjacent-media warming for the story viewer.
 *
 * Posters around the active story are always warmed: they are small and are exactly what
 * keeps a story change from flashing black. The *next* video additionally gets its first
 * seconds pulled into the HTTP cache — normalized story MP4s are faststart at ~2.5 Mbps,
 * so three seconds is ~1 MB and turns the next story's startup into a cache read — but
 * only once the story being watched is buffered well ahead (`warmNextVideo`), so warming
 * never competes with current playback on a slow link.
 *
 * Only one video is ever warmed, and a story change aborts it: rapid tapping never leaves
 * a queue of background downloads.
 */

export interface PrefetchTarget {
  posterUrl?: string;
  video?: VideoSource;
}

function warmImage(warmed: Set<string>, url: string): void {
  if (!url || warmed.has(url)) return;
  warmed.add(url);
  const image = new Image();
  image.onerror = () => {
    // Forget it so a later attempt can retry instead of inheriting a permanent failure.
    warmed.delete(url);
  };
  image.decoding = "async";
  image.src = url;
}

export function useMediaPrefetch(targets: {
  next?: PrefetchTarget;
  afterNext?: PrefetchTarget;
  previous?: PrefetchTarget;
  warmNextVideo?: boolean;
}): void {
  const postersRef = useRef(new Set<string>());
  const videosRef = useRef(new Set<string>());
  const { next, afterNext, previous, warmNextVideo = false } = targets;

  useEffect(() => {
    if (typeof window === "undefined") return;
    [next?.posterUrl, afterNext?.posterUrl, previous?.posterUrl].forEach((url) => {
      if (url) warmImage(postersRef.current, url);
    });
  }, [next?.posterUrl, afterNext?.posterUrl, previous?.posterUrl]);

  const nextVideo = next?.video;
  const nextKey = nextVideo ? `${nextVideo.mp4}|${nextVideo.hls ?? ""}` : "";
  useEffect(() => {
    if (!nextVideo || !warmNextVideo || videosRef.current.has(nextKey)) return;
    const controller = new AbortController();
    videosRef.current.add(nextKey);
    void warmVideo(nextVideo, { signal: controller.signal, seconds: 3 }).then(() => {
      // An aborted warm read little or nothing; allow a later attempt.
      if (controller.signal.aborted) videosRef.current.delete(nextKey);
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextKey, warmNextVideo]);
}
