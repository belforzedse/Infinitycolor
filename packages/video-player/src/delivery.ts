/**
 * What a player may use from an upload row.
 *
 * The media worker keeps the row's classic `url` pointing at a normalized progressive MP4
 * (the interface every client already understands) and records its other outputs — HLS
 * master, poster, dimensions — under `provider_metadata.video`. Those outputs are only
 * trusted while they still describe the file the row points at: an admin "replace media"
 * leaves stale metadata behind, and the fresh upload must play as-is until reprocessed.
 */

export interface VideoAssetLike {
  url?: string | null;
  mime?: string | null;
  previewUrl?: string | null;
  width?: number | null;
  height?: number | null;
  provider_metadata?: unknown;
}

export interface VideoDelivery {
  /** Progressive MP4 (or, for an unprocessed upload, the original file). Unresolved path. */
  mp4: string;
  /** HLS master playlist, when the ladder is published. Unresolved path. */
  hls: string | null;
  poster: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** `false` hides a sound toggle that would do nothing; `null` when unknown. */
  hasAudio: boolean | null;
  /** Uploaded but not yet normalized: the file may not decode everywhere yet. */
  processing: boolean;
}

const PROCESSING_STATUSES = new Set(["queued", "probing", "processing"]);

function isMediaPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("..")) return false;
  return value.startsWith("/uploads/") || /^https?:\/\//i.test(value);
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function readVideoDelivery(asset: VideoAssetLike | null | undefined): VideoDelivery | null {
  if (!asset?.url) return null;
  const metadata = asset.provider_metadata;
  const video =
    metadata && typeof metadata === "object" && (metadata as { video?: unknown }).video &&
    typeof (metadata as { video?: unknown }).video === "object"
      ? ((metadata as { video: Record<string, any> }).video)
      : null;
  const output = video?.output && typeof video.output === "object" ? video.output : null;
  const owned = Boolean(output?.mp4?.url && output.mp4.url === asset.url);

  const poster = isMediaPath(asset.previewUrl)
    ? asset.previewUrl
    : owned && isMediaPath(output?.poster?.url)
      ? output.poster.url
      : null;

  return {
    mp4: asset.url,
    hls: owned && isMediaPath(output?.hls?.master) ? output.hls.master : null,
    poster,
    width: owned ? positiveNumber(output.width) : positiveNumber(asset.width),
    height: owned ? positiveNumber(output.height) : positiveNumber(asset.height),
    durationMs: owned ? positiveNumber(output.durationMs) : null,
    hasAudio: owned && typeof output.hasAudio === "boolean" ? output.hasAudio : null,
    processing: !owned && PROCESSING_STATUSES.has(String(video?.status ?? "")),
  };
}

/** A delivery with every path resolved to a fetchable URL (CDN rewrite, origin checks). */
export interface VideoSource {
  mp4: string;
  hls?: string | null;
  poster?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  hasAudio?: boolean | null;
  processing?: boolean;
}

export function resolveVideoSource(
  delivery: VideoDelivery | null,
  resolve: (path: string) => string,
): VideoSource | null {
  if (!delivery) return null;
  const mp4 = resolve(delivery.mp4);
  if (!mp4) return null;
  return {
    mp4,
    hls: delivery.hls ? resolve(delivery.hls) || null : null,
    poster: delivery.poster ? resolve(delivery.poster) || null : null,
    width: delivery.width,
    height: delivery.height,
    durationMs: delivery.durationMs,
    hasAudio: delivery.hasAudio,
    processing: delivery.processing,
  };
}
