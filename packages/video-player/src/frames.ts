/**
 * Knowing when a real frame is on screen, and when none ever will be.
 */

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Calls `onFrame` once, when the first decoded frame is presented. Uses
 * `requestVideoFrameCallback` where available (it fires on actual compositor
 * presentation, so a poster can stay up until then with no black flash) and falls back to
 * "playing and time has moved" elsewhere. Both run together: whichever sees the frame
 * first wins, so a browser quirk in one path cannot leave the poster up forever.
 */
export function watchFirstFrame(video: HTMLVideoElement, onFrame: () => void): () => void {
  const element = video as FrameCallbackVideo;
  let done = false;
  let handle: number | null = null;

  const check = () => {
    if (video.readyState >= 2 && video.currentTime > 0) fire();
  };
  const cleanup = () => {
    video.removeEventListener("timeupdate", check);
    video.removeEventListener("playing", check);
    if (handle !== null) {
      element.cancelVideoFrameCallback?.(handle);
      handle = null;
    }
  };
  function fire() {
    if (done) return;
    done = true;
    cleanup();
    onFrame();
  }

  if (typeof element.requestVideoFrameCallback === "function") {
    handle = element.requestVideoFrameCallback(() => {
      handle = null;
      fire();
    });
  }
  video.addEventListener("timeupdate", check);
  video.addEventListener("playing", check);

  return () => {
    done = true;
    cleanup();
  };
}

/** A playing element that has decoded at least one frame. */
export function hasDecodableVideoTrack(video: HTMLVideoElement): boolean {
  if (video.videoWidth > 0 && video.videoHeight > 0) return true;
  const quality = (video as HTMLVideoElement & {
    getVideoPlaybackQuality?: () => { totalVideoFrames: number };
  }).getVideoPlaybackQuality?.();
  return Boolean(quality && quality.totalVideoFrames > 0);
}

/**
 * Chromium builds without platform HEVC parse an HEVC file, fire `playing`, advance
 * `currentTime` and play the audio — while decoding zero frames and raising no `error`.
 * After `playing`, check twice, 600 ms apart, that frames exist once time has moved.
 */
export const DECODE_PROBE_MS = 600;
export const DECODE_PROBE_ATTEMPTS = 2;
