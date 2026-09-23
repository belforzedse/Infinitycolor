/**
 * Picking the delivery path for one playback.
 *
 * Order follows hls.js's recommended default: hls.js wherever Media Source Extensions
 * (or ManagedMediaSource, iOS 17.1+) can play H.264/AAC in fMP4; native HLS only where
 * MSE is missing (iPhones before iOS 17.1, some in-app WebViews); the progressive MP4
 * otherwise. Native-first is deliberately avoided: Chromium now answers "maybe" to
 * `canPlayType("application/vnd.apple.mpegurl")` without playing every stream reliably.
 * No user-agent sniffing — only feature checks, and hls.js itself is not loaded to make
 * the decision.
 */

export type PlaybackEngine = "hls.js" | "native-hls" | "mp4";

const MSE_H264 = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';

function mediaSourceConstructor(): { isTypeSupported?: (type: string) => boolean } | null {
  if (typeof window === "undefined") return null;
  const candidate = window as unknown as Record<string, unknown>;
  return (candidate.ManagedMediaSource ?? candidate.MediaSource ?? candidate.WebKitMediaSource ?? null) as {
    isTypeSupported?: (type: string) => boolean;
  } | null;
}

/** The same answer as `Hls.isSupported()`, without loading hls.js. */
export function isMseH264Supported(): boolean {
  const MediaSourceType = mediaSourceConstructor();
  if (!MediaSourceType || typeof MediaSourceType.isTypeSupported !== "function") return false;
  try {
    return MediaSourceType.isTypeSupported(MSE_H264);
  } catch {
    return false;
  }
}

export function canPlayNativeHls(video?: HTMLVideoElement | null): boolean {
  const element =
    video ?? (typeof document !== "undefined" ? document.createElement("video") : null);
  try {
    return Boolean(element?.canPlayType?.("application/vnd.apple.mpegurl"));
  } catch {
    return false;
  }
}

/**
 * Session circuit breaker. A playlist that cannot be fetched at all (status 0: CORS
 * missing on the media host, blocked, offline) will fail the same way for every video, so
 * after the first one the session goes straight to MP4 instead of paying a failed
 * round trip per video. A 404 on one playlist does not trip it.
 */
const CIRCUIT_KEY = "infinity.video.hls-off";
let circuitOpen: boolean | null = null;

export function isHlsCircuitOpen(): boolean {
  if (circuitOpen === null) {
    try {
      circuitOpen = window.sessionStorage.getItem(CIRCUIT_KEY) === "1";
    } catch {
      circuitOpen = false;
    }
  }
  return circuitOpen;
}

export function openHlsCircuit(): void {
  circuitOpen = true;
  try {
    window.sessionStorage.setItem(CIRCUIT_KEY, "1");
  } catch {
    // Private mode / blocked storage: the in-memory flag still covers this page.
  }
}

export function resetHlsCircuit(): void {
  circuitOpen = null;
  try {
    window.sessionStorage.removeItem(CIRCUIT_KEY);
  } catch {
    // ignore
  }
}

export function chooseEngine(
  source: { hls?: string | null },
  { allowHls, video }: { allowHls: boolean; video?: HTMLVideoElement | null },
): PlaybackEngine {
  if (!allowHls || !source.hls || isHlsCircuitOpen()) return "mp4";
  if (isMseH264Supported()) return "hls.js";
  if (canPlayNativeHls(video)) return "native-hls";
  return "mp4";
}
