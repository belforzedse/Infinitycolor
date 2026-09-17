/**
 * Chromium without platform HEVC parses a `video/quicktime` clip, reports
 * `readyState 4`, fires `playing`, advances `currentTime` — and decodes zero
 * frames, with no `error` event. Product gallery media from phones is often
 * exactly that shape. The only reliable signal is a video track with no
 * dimensions and no decoded frames.
 */

export const VIDEO_DECODE_PROBE_MS = 600;
export const VIDEO_DECODE_PROBE_ATTEMPTS = 2;

export function hasDecodableVideoTrack(video: HTMLVideoElement): boolean {
  if (video.videoWidth > 0 && video.videoHeight > 0) return true;
  const quality = video.getVideoPlaybackQuality?.();
  if (quality && quality.totalVideoFrames > 0) return true;
  return false;
}

/** HTMLMediaElement error codes 3 (decode) and 4 (src not supported). */
export function isUnsupportedMediaError(video: HTMLVideoElement): boolean {
  const code = video.error?.code;
  return code === 3 || code === 4;
}
