import {
  hasDecodableVideoTrack,
  isUnsupportedMediaError,
} from "../video-decode";

function videoStub(overrides: {
  videoWidth?: number;
  videoHeight?: number;
  totalVideoFrames?: number | null;
  errorCode?: number | null;
}): HTMLVideoElement {
  const { videoWidth = 0, videoHeight = 0, totalVideoFrames = null, errorCode = null } = overrides;
  return {
    videoWidth,
    videoHeight,
    error: errorCode == null ? null : { code: errorCode },
    getVideoPlaybackQuality:
      totalVideoFrames == null
        ? undefined
        : () =>
            ({
              totalVideoFrames,
              droppedVideoFrames: 0,
              corruptedVideoFrames: 0,
              creationTime: 0,
            }) as VideoPlaybackQuality,
  } as HTMLVideoElement;
}

describe("hasDecodableVideoTrack", () => {
  it("accepts a clip that actually decoded pixels", () => {
    expect(hasDecodableVideoTrack(videoStub({ videoWidth: 720, videoHeight: 1280 }))).toBe(true);
  });

  it("rejects the Chromium HEVC signature: playing, zero dimensions, zero frames", () => {
    expect(
      hasDecodableVideoTrack(videoStub({ videoWidth: 0, videoHeight: 0, totalVideoFrames: 0 })),
    ).toBe(false);
  });

  it("accepts a decoder that reports frames even if width is late", () => {
    expect(
      hasDecodableVideoTrack(videoStub({ videoWidth: 0, videoHeight: 0, totalVideoFrames: 12 })),
    ).toBe(true);
  });
});

describe("isUnsupportedMediaError", () => {
  it("treats decode and src-not-supported as unplayable", () => {
    expect(isUnsupportedMediaError(videoStub({ errorCode: 3 }))).toBe(true);
    expect(isUnsupportedMediaError(videoStub({ errorCode: 4 }))).toBe(true);
  });

  it("leaves network and abort errors to the native player", () => {
    expect(isUnsupportedMediaError(videoStub({ errorCode: 1 }))).toBe(false);
    expect(isUnsupportedMediaError(videoStub({ errorCode: 2 }))).toBe(false);
    expect(isUnsupportedMediaError(videoStub({ errorCode: null }))).toBe(false);
  });
});
