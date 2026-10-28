import type { HlsConfig } from "hls.js";

/**
 * Bandwidth memory across players. hls.js measures throughput per instance and forgets
 * it on `destroy()`, so without this every new post/video would start from the library's
 * 500 kbps default and spend its first segment at the bottom rung. The estimate is kept
 * for the tab session; Network Information (`navigator.connection.downlink`, Chromium)
 * seeds the very first player when available.
 */
const BANDWIDTH_KEY = "infinity.video.bw";
const DEFAULT_ESTIMATE_BPS = 1_000_000;
let remembered: number | null = null;

export function readBandwidthEstimate(): number {
  if (remembered) return remembered;
  try {
    const stored = Number(window.sessionStorage.getItem(BANDWIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      remembered = stored;
      return stored;
    }
  } catch {
    // storage unavailable
  }
  const downlinkMbps = (navigator as Navigator & { connection?: { downlink?: number } }).connection?.downlink;
  if (typeof downlinkMbps === "number" && downlinkMbps > 0) {
    // `downlink` is an optimistic, capped figure; discount it.
    return Math.min(downlinkMbps * 1_000_000 * 0.7, 20_000_000);
  }
  return DEFAULT_ESTIMATE_BPS;
}

export function recordBandwidthEstimate(bitsPerSecond: number): void {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return;
  remembered = bitsPerSecond;
  try {
    window.sessionStorage.setItem(BANDWIDTH_KEY, String(Math.round(bitsPerSecond)));
  } catch {
    // storage unavailable
  }
}

export function resetBandwidthEstimate(): void {
  remembered = null;
  try {
    window.sessionStorage.removeItem(BANDWIDTH_KEY);
  } catch {
    // ignore
  }
}

const retry = (maxNumRetry: number, retryDelayMs: number, maxRetryDelayMs: number) => ({
  maxNumRetry,
  retryDelayMs,
  maxRetryDelayMs,
});

/**
 * The index of the smallest level that still covers the player box at device resolution,
 * which is the same rule hls.js's `capLevelToPlayerSize` applies. Levels are hls.js's,
 * sorted by bitrate, which for this ladder is also by size. Returns -1 while the box is
 * unknown (not laid out), leaving hls.js to decide.
 */
export function levelCapForPlayer(
  levels: ReadonlyArray<{ width?: number; height?: number }>,
  box: { width: number; height: number },
  pixelRatio: number,
): number {
  if (levels.length === 0 || box.width <= 0 || box.height <= 0) return -1;
  const width = box.width * pixelRatio;
  const height = box.height * pixelRatio;
  const index = levels.findIndex((level) => (level.width ?? 0) >= width && (level.height ?? 0) >= height);
  return index === -1 ? levels.length - 1 : index;
}

/**
 * hls.js settings for short-form clips in a scrolling UI, where a viewer may swipe away at
 * any moment and every clip has a progressive MP4 to fall back to.
 */
export function buildHlsConfig(startEstimateBps: number): Partial<HlsConfig> {
  return {
    // Forward buffer: four 2 s segments. Library defaults (30 s / 60 MB) would download
    // whole clips the viewer has already swiped past.
    maxBufferLength: 8,
    maxMaxBufferLength: 15,
    maxBufferSize: 15 * 1000 * 1000,
    // Keep only a little played media: short clips are rarely rewound, and memory in a
    // long session matters more (the default keeps everything).
    backBufferLength: 4,
    // A phone-sized player never needs the 1080p rung; the ladder is capped to the
    // element's pixel size (hls.js accounts for devicePixelRatio).
    capLevelToPlayerSize: true,
    // The engine starts loading itself, on MANIFEST_PARSED, after applying that cap. With
    // hls.js starting on its own, the first level could be picked before the cap existed.
    // That happens when the manifest comes from cache (the engine's preflight), and it
    // started a 270x480 player on the 1080p rung (1.6 MB before the first frame).
    autoStartLoad: false,
    // Start from the remembered estimate instead of spending a test fragment on it.
    startLevel: -1,
    testBandwidth: false,
    abrEwmaDefaultEstimate: startEstimateBps,
    // Request the first fragment while the element is still getting ready.
    startFragPrefetch: true,
    // fMP4 needs only passthrough remuxing, so a worker per instance buys nothing and
    // costs a thread spin-up on every story/post change.
    enableWorker: false,
    lowLatencyMode: false,
    // Playlists fail fast (there is an MP4 to fall back to); segments get patience.
    manifestLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 5_000,
        maxLoadTimeMs: 10_000,
        timeoutRetry: retry(1, 0, 0),
        errorRetry: retry(1, 500, 1_000),
      },
    },
    playlistLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 5_000,
        maxLoadTimeMs: 10_000,
        timeoutRetry: retry(1, 0, 0),
        errorRetry: retry(1, 500, 1_000),
      },
    },
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 8_000,
        maxLoadTimeMs: 20_000,
        timeoutRetry: retry(2, 0, 0),
        errorRetry: retry(3, 500, 4_000),
      },
    },
  };
}
