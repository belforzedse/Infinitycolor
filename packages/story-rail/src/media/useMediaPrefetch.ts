"use client";

import { useEffect, useRef } from "react";

/**
 * Conservative adjacent-media warming.
 *
 * Story videos in this catalogue are 14–51 MB, so pulling the next story's body ahead of
 * time would cost more than the stall it saves. What actually removes the black flash is
 * having the *poster* ready, and what removes the metadata round-trip is having the moov
 * atom — which for these files sits at the end, so `preload="metadata"` costs two small
 * range requests rather than the whole body.
 *
 * A URL is only recorded as warm once the browser says it is ready; a request that fails
 * is forgotten so it can be retried, rather than being cached as permanently broken.
 */

type Warmth = "pending" | "warm";

export interface PrefetchTarget {
  posterUrl?: string;
  videoUrl?: string;
}

interface PrefetchCache {
  state: Map<string, Warmth>;
  release: Map<string, () => void>;
}

function createCache(): PrefetchCache {
  return { state: new Map(), release: new Map() };
}

function warmImage(cache: PrefetchCache, url: string): void {
  if (!url || cache.state.has(url)) return;
  cache.state.set(url, "pending");

  const image = new Image();
  const done = (warm: boolean) => {
    image.onload = null;
    image.onerror = null;
    cache.release.delete(url);
    if (warm) cache.state.set(url, "warm");
    else cache.state.delete(url);
  };
  image.onload = () => done(true);
  image.onerror = () => done(false);
  cache.release.set(url, () => {
    done(false);
    image.src = "";
  });
  image.src = url;
}

function warmVideoMetadata(cache: PrefetchCache, url: string): void {
  if (!url || cache.state.has(url)) return;
  cache.state.set(url, "pending");

  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;

  const cleanup = () => {
    video.removeEventListener("loadedmetadata", onLoaded);
    video.removeEventListener("error", onError);
    cache.release.delete(url);
    // removeAttribute + load(), never `src = ""`: an empty string resolves against the
    // document URL and makes the browser fetch the page itself as media.
    video.removeAttribute("src");
    video.load();
  };
  function onLoaded() {
    cache.state.set(url, "warm");
    cleanup();
  }
  function onError() {
    // Forget it so a later attempt can retry instead of inheriting a permanent failure.
    cache.state.delete(url);
    cleanup();
  }

  video.addEventListener("loadedmetadata", onLoaded);
  video.addEventListener("error", onError);
  cache.release.set(url, () => {
    cache.state.delete(url);
    cleanup();
  });
  video.src = url;
  video.load();
}

/**
 * Warms the posters around the active story and, at most, the metadata of the single
 * next video. Everything else stays lazy.
 */
export function useMediaPrefetch(targets: {
  next?: PrefetchTarget;
  afterNext?: PrefetchTarget;
  previous?: PrefetchTarget;
}): void {
  const cacheRef = useRef<PrefetchCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = createCache();

  const { next, afterNext, previous } = targets;

  useEffect(() => {
    const cache = cacheRef.current;
    if (!cache || typeof window === "undefined") return;

    // Posters are small and are exactly what prevents a black frame on advance.
    [next?.posterUrl, afterNext?.posterUrl, previous?.posterUrl].forEach((url) => {
      if (url) warmImage(cache, url);
    });
    // Only one video ahead, metadata only.
    if (next?.videoUrl) warmVideoMetadata(cache, next.videoUrl);
  }, [next?.posterUrl, next?.videoUrl, afterNext?.posterUrl, previous?.posterUrl]);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      if (!cache) return;
      cache.release.forEach((release) => release());
      cache.release.clear();
      cache.state.clear();
    };
  }, []);
}
