import { chooseEngine } from "./capabilities";
import type { VideoSource } from "./delivery";
import { readBandwidthEstimate } from "./hls-config";

/**
 * Getting the *next* video's first seconds into the HTTP cache before the viewer asks for
 * it, so the element that eventually plays it starts from cache instead of the network.
 *
 * - MP4: a detached, muted `<video preload="auto">` reads the file through the browser's
 *   own media stack until a few seconds are buffered, then lets go. Media range responses
 *   land in the HTTP cache, and going through the same stack (rather than `fetch`) is
 *   what makes the later element reuse them.
 * - HLS (hls.js path only): the master and variant playlists, init segment and first
 *   segment of the rendition hls.js is likely to pick, fetched in CORS mode exactly as
 *   hls.js will fetch them. Native HLS (AVFoundation) keeps its own cache, so nothing is
 *   warmed there.
 *
 * Everything stops on `signal` abort; a fast swipe never leaves downloads behind.
 */

export interface WarmOptions {
  signal?: AbortSignal;
  allowHls?: boolean;
  /** Seconds of media to buffer ahead for MP4. */
  seconds?: number;
  /** Safety stop for an MP4 warm that never reaches `seconds`. */
  timeoutMs?: number;
}

export async function warmVideo(source: VideoSource, options: WarmOptions = {}): Promise<void> {
  if (options.signal?.aborted || typeof document === "undefined") return;
  const engine = chooseEngine(source, { allowHls: options.allowHls ?? false });
  if (engine === "hls.js" && source.hls) {
    await warmHls(source.hls, options.signal).catch(() => undefined);
    return;
  }
  if (engine === "mp4" || engine === "webm") await warmMp4(engine === "webm" ? source.webm! : source.mp4, options);
}

function warmMp4(url: string, { signal, seconds = 3, timeoutMs = 15_000 }: WarmOptions): Promise<void> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.removeEventListener("progress", check);
      video.removeEventListener("canplaythrough", finish);
      video.removeEventListener("error", finish);
      signal?.removeEventListener("abort", finish);
      // Release the connection; what was read stays in the HTTP cache.
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // ignore
      }
      resolve();
    };
    const check = () => {
      const { buffered } = video;
      if (buffered.length && buffered.end(0) >= seconds) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener("progress", check);
    video.addEventListener("canplaythrough", finish);
    video.addEventListener("error", finish);
    signal?.addEventListener("abort", finish, { once: true });
    video.src = url;
    video.load();
  });
}

interface Variant {
  uri: string;
  bandwidth: number;
  height: number;
}

export function parseMasterVariants(text: string): Variant[] {
  const lines = text.split(/\r?\n/);
  const variants: Variant[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(line.slice(18))?.[1] ?? 0);
    const height = Number(/RESOLUTION=\d+x(\d+)/.exec(line)?.[1] ?? 0);
    const uri = lines.slice(index + 1).find((candidate) => candidate && !candidate.startsWith("#"));
    if (uri) variants.push({ uri: uri.trim(), bandwidth, height });
  }
  return variants;
}

/** The rendition hls.js will most likely start on: fits the estimate and the screen. */
export function pickWarmVariant(variants: Variant[], estimateBps: number, maxHeight: number): Variant | null {
  if (variants.length === 0) return null;
  const sorted = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);
  const fitting = sorted.filter(
    (variant) => variant.bandwidth <= estimateBps * 0.8 && (!variant.height || variant.height <= maxHeight),
  );
  return fitting.at(-1) ?? sorted[0];
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { mode: "cors", credentials: "omit", signal, priority: "low" } as RequestInit);
  if (!response.ok) throw new Error(`warm ${response.status}`);
  return response.text();
}

async function fetchDiscard(url: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { mode: "cors", credentials: "omit", signal, priority: "low" } as RequestInit);
  await response.arrayBuffer();
}

async function warmHls(masterUrl: string, signal?: AbortSignal): Promise<void> {
  const master = await fetchText(masterUrl, signal);
  const screenHeight = Math.round((window.screen?.height || window.innerHeight || 1280) * (window.devicePixelRatio || 1));
  const variant = pickWarmVariant(parseMasterVariants(master), readBandwidthEstimate(), screenHeight);
  if (!variant) return;
  const variantUrl = new URL(variant.uri, masterUrl).toString();
  const playlist = await fetchText(variantUrl, signal);
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1];
  const firstSegment = playlist.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
  await Promise.all([
    init ? fetchDiscard(new URL(init, variantUrl).toString(), signal) : undefined,
    firstSegment ? fetchDiscard(new URL(firstSegment.trim(), variantUrl).toString(), signal) : undefined,
  ]);
}
