import { MediaProcessingError } from "../media-process";
import {
  interpretProbe,
  parseRational,
  validateProbe,
  type FfprobeOutput,
  type VideoProbe,
} from "../video-normalization";

function ffprobe(video: Record<string, unknown>, extra: Partial<FfprobeOutput> = {}): FfprobeOutput {
  return {
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.265", bit_rate: "11000000" },
    streams: [
      {
        codec_type: "video",
        codec_name: "hevc",
        profile: "Main 10",
        width: 1920,
        height: 1080,
        pix_fmt: "yuv420p10le",
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
        sample_aspect_ratio: "1:1",
        ...video,
      },
      { codec_type: "audio", codec_name: "aac", channels: 1 },
    ],
    ...extra,
  };
}

describe("parseRational", () => {
  it.each([
    ["30000/1001", 29.97],
    ["30/1", 30],
    ["4:3", 1.3333],
    ["0/0", null],
    ["0:1", null],
    [undefined, null],
  ])("%s → %s", (input, expected) => {
    const value = parseRational(input as string | undefined);
    if (expected === null) expect(value).toBeNull();
    else expect(value).toBeCloseTo(expected, 3);
  });
});

describe("interpretProbe", () => {
  it("swaps display dimensions for an iPhone portrait clip stored landscape with a -90° matrix", () => {
    const probe = interpretProbe(
      ffprobe({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }),
      false,
    );
    expect(probe).toEqual(
      expect.objectContaining({
        width: 1920,
        height: 1080,
        rotation: 270,
        displayWidth: 1080,
        displayHeight: 1920,
      }),
    );
  });

  it("reads the legacy `rotate` tag from older ffprobe builds", () => {
    const probe = interpretProbe(ffprobe({ tags: { rotate: "90" } }), true);
    expect(probe.rotation).toBe(90);
    expect(probe.displayWidth).toBe(1080);
  });

  it("expands non-square pixels into the display size", () => {
    const probe = interpretProbe(
      ffprobe({ width: 1440, height: 1080, sample_aspect_ratio: "4:3" }),
      true,
    );
    expect(probe.displayWidth).toBe(1920);
    expect(probe.displayHeight).toBe(1080);
  });

  it("classifies HLG and PQ transfers as HDR and keeps SDR as SDR", () => {
    expect(interpretProbe(ffprobe({ color_transfer: "arib-std-b67" }), true).hdr).toBe("hlg");
    expect(interpretProbe(ffprobe({ color_transfer: "smpte2084" }), true).hdr).toBe("pq");
    expect(interpretProbe(ffprobe({ color_transfer: "bt709" }), true).hdr).toBeNull();
  });

  it("flags variable frame rate when the average departs from the nominal rate", () => {
    const screenRecording = interpretProbe(ffprobe({ r_frame_rate: "60/1", avg_frame_rate: "3742/100" }), true);
    expect(screenRecording.variableFrameRate).toBe(true);
    const phone = interpretProbe(ffprobe({ r_frame_rate: "30/1", avg_frame_rate: "2999/100" }), true);
    expect(phone.variableFrameRate).toBe(false);
  });

  it("records Dolby Vision profile and bit depth", () => {
    const probe = interpretProbe(
      ffprobe({ side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8 }] }),
      true,
    );
    expect(probe.dolbyVisionProfile).toBe(8);
    expect(probe.bitDepth).toBe(10);
  });

  it("ignores attached cover art and reports a silent clip without audio", () => {
    const probe = interpretProbe(
      {
        format: { format_name: "mp4", duration: "3" },
        streams: [
          { codec_type: "video", codec_name: "mjpeg", width: 300, height: 300, disposition: { attached_pic: 1 } },
          { codec_type: "video", codec_name: "h264", width: 640, height: 360, r_frame_rate: "25/1", avg_frame_rate: "25/1" },
        ],
      },
      true,
    );
    expect(probe.videoCodec).toBe("h264");
    expect(probe.hasAudio).toBe(false);
    expect(probe.durationMs).toBe(3000);
  });
});

describe("validateProbe", () => {
  const limits = { minDurationMs: 300, maxDurationMs: 600_000, maxDimension: 8192 };
  const valid = interpretProbe(ffprobe({}), true);

  function codeOf(probe: VideoProbe): string | null {
    try {
      validateProbe(probe, limits);
      return null;
    } catch (error) {
      return (error as MediaProcessingError).code;
    }
  }

  it("accepts an ordinary phone clip", () => {
    expect(codeOf(valid)).toBeNull();
  });

  it("rejects files without a video stream, over-long clips and huge frames with distinct codes", () => {
    expect(codeOf({ ...valid, videoCodec: null })).toBe("no_video_stream");
    expect(codeOf({ ...valid, durationMs: 601_000 })).toBe("duration_exceeded");
    expect(codeOf({ ...valid, durationMs: 100 })).toBe("probe_failed");
    expect(codeOf({ ...valid, displayWidth: 9000 })).toBe("dimensions_exceeded");
  });

  it("marks invalid input as permanent and worker trouble as retryable", () => {
    expect(new MediaProcessingError("no_video_stream", "x").retryable).toBe(false);
    expect(new MediaProcessingError("killed_oom", "x").retryable).toBe(true);
    expect(new MediaProcessingError("storage_error", "x").retryable).toBe(true);
  });
});
