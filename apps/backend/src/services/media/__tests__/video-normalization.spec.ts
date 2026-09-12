import {
  buildTranscodeArgs,
  decideNormalization,
  type VideoProbe,
} from "../video-normalization";

function probe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    containerFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    videoCodec: "h264",
    audioCodec: "aac",
    width: 720,
    height: 1280,
    durationMs: 10_000,
    bitRate: 2_000_000,
    fastStart: true,
    ...overrides,
  };
}

describe("decideNormalization", () => {
  it("leaves a faststart H.264/AAC MP4 alone", () => {
    const decision = decideNormalization(probe(), { mime: "video/mp4", extension: ".mp4" });
    expect(decision).toEqual({ needed: false, reasons: [] });
  });

  it("leaves a VP9 WebM alone, including its atom layout", () => {
    // WebM has no moov atom; the faststart check must not flag it.
    const decision = decideNormalization(
      probe({ videoCodec: "vp9", audioCodec: "opus", containerFormats: ["matroska", "webm"], fastStart: false }),
      { mime: "video/webm", extension: ".webm" },
    );
    expect(decision.needed).toBe(false);
  });

  it("flags HEVC, which Chromium parses but cannot decode", () => {
    const decision = decideNormalization(probe({ videoCodec: "hevc" }), {
      mime: "video/quicktime",
      extension: ".mov",
    });
    expect(decision.needed).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("hevc")]),
    );
  });

  it("flags a QuickTime container even when the codecs inside are fine", () => {
    // This is the one-in-sixteen production case: H.264/AAC, but served as
    // video/quicktime, which no browser advertises support for.
    const decision = decideNormalization(probe(), {
      mime: "video/quicktime",
      extension: ".mov",
    });
    expect(decision.needed).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("video/quicktime")]),
    );
  });

  it("flags a file whose moov atom sits behind the media data", () => {
    const decision = decideNormalization(probe({ fastStart: false }), {
      mime: "video/mp4",
      extension: ".mp4",
    });
    expect(decision.needed).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("fast start")]),
    );
  });

  it("flags a file with no video stream at all", () => {
    const decision = decideNormalization(probe({ videoCodec: null }), { mime: "video/mp4" });
    expect(decision.needed).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("no video stream")]),
    );
  });

  it("accepts a video with no audio track", () => {
    const decision = decideNormalization(probe({ audioCodec: null }), {
      mime: "video/mp4",
      extension: ".mp4",
    });
    expect(decision.needed).toBe(false);
  });
});

describe("buildTranscodeArgs", () => {
  it("names the container explicitly rather than relying on the output extension", () => {
    // The caller writes to `<name>.mp4.partial` and renames atomically once the encode
    // succeeds. ffmpeg picks its muxer from the extension, so without an explicit `-f`
    // it fails with "Error initializing the muxer: Invalid argument".
    const args = buildTranscodeArgs("/in/story.mov", "/out/story_web.mp4.partial");
    const formatIndex = args.indexOf("-f");
    expect(formatIndex).toBeGreaterThan(-1);
    expect(args[formatIndex + 1]).toBe("mp4");
    expect(args[args.length - 1]).toBe("/out/story_web.mp4.partial");
  });

  it("produces the web-safe baseline with faststart", () => {
    const args = buildTranscodeArgs("/in/a.mov", "/out/a.mp4").join(" ");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-pix_fmt yuv420p");
    expect(args).toContain("-c:a aac");
    expect(args).toContain("-movflags +faststart");
  });

  it("never upscales a source that is already smaller than the cap", () => {
    const args = buildTranscodeArgs("/in/a.mov", "/out/a.mp4", { maxHeight: 1280 });
    expect(args).toContain("scale=-2:'min(ih,1280)'");
  });
});
