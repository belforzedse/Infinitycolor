import {
  buildHlsArgs,
  buildMp4Args,
  buildPosterArgs,
  frameSizeForShortEdge,
  hlsSegmentSeconds,
  planEncode,
  selectRenditions,
  targetFrameRate,
  videoFilterChain,
} from "../video-encoding";
import type { VideoProbe } from "../video-normalization";

function probe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    containerFormats: ["mov", "mp4"],
    videoCodec: "hevc",
    videoProfile: "Main",
    audioCodec: "aac",
    width: 1920,
    height: 1080,
    displayWidth: 1080,
    displayHeight: 1920,
    rotation: 270,
    sampleAspectRatio: 1,
    frameRate: 30,
    averageFrameRate: 30,
    variableFrameRate: false,
    pixelFormat: "yuv420p",
    bitDepth: 8,
    colorPrimaries: "bt709",
    colorTransfer: "bt709",
    colorSpace: "bt709",
    colorRange: "tv",
    hdr: null,
    dolbyVisionProfile: null,
    hasAudio: true,
    audioChannels: 2,
    durationMs: 10_000,
    bitRate: 11_000_000,
    fastStart: false,
    ...overrides,
  };
}

const argValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("renditions", () => {
  it("builds the full ladder for a 1080x1920 portrait source, preserving aspect", () => {
    expect(selectRenditions(1080, 1920).map((r) => `${r.width}x${r.height}`)).toEqual([
      "360x640",
      "540x960",
      "720x1280",
      "1080x1920",
    ]);
  });

  it("never upscales: a 540p source stops at 540", () => {
    expect(selectRenditions(960, 540).map((r) => r.shortEdge)).toEqual([360, 540]);
  });

  it("gives a near-rung source that rung at its own size instead of dropping it", () => {
    const top = selectRenditions(1072, 1906).at(-1)!;
    expect(top.shortEdge).toBe(1072);
    expect(top.width).toBe(1072);
  });

  it("encodes a tiny source once at its own even size", () => {
    expect(selectRenditions(241, 427).map((r) => `${r.width}x${r.height}`)).toEqual(["240x426"]);
  });

  it("always produces even dimensions, including odd screen-recording sizes", () => {
    for (const size of [frameSizeForShortEdge(886, 1919, 720), frameSizeForShortEdge(1917, 1079, 720)]) {
      expect(size.width % 2).toBe(0);
      expect(size.height % 2).toBe(0);
    }
    // 886x1919 is ~0.4617; 720 short edge must keep that ratio within rounding.
    const { width, height } = frameSizeForShortEdge(886, 1919, 720);
    expect(Math.abs(width / height - 886 / 1919)).toBeLessThan(0.005);
  });

  it("caps the short edge, not the height, so landscape 4K is not starved", () => {
    const plan = planEncode(probe({ displayWidth: 3840, displayHeight: 2160 }));
    expect(`${plan.fallback.width}x${plan.fallback.height}`).toBe("1280x720");
    expect(`${plan.top.width}x${plan.top.height}`).toBe("1920x1080");
  });

  it("keeps extreme aspect ratios inside the rung pixel budget", () => {
    const { width, height } = frameSizeForShortEdge(720, 7200, 720);
    expect(width * height).toBeLessThanOrEqual(720 * 720 * (16 / 9) * 1.25);
  });

  it("lists the start rendition first for players that take the first entry", () => {
    const plan = planEncode(probe());
    expect(plan.masterOrder.map((r) => r.shortEdge)).toEqual([540, 360, 720, 1080]);
  });
});

describe("targetFrameRate", () => {
  it.each([
    [{ frameRate: 60, averageFrameRate: 60 }, "30/1"],
    [{ frameRate: 59.94, averageFrameRate: 59.94 }, "30000/1001"],
    [{ frameRate: 50, averageFrameRate: 50 }, "25/1"],
    [{ frameRate: 120, averageFrameRate: 120 }, "30/1"],
    [{ frameRate: 24, averageFrameRate: 24 }, "24/1"],
    [{ frameRate: 29.97, averageFrameRate: 29.97 }, "30000/1001"],
    // VFR phone capture: the container tick rate is meaningless, the average is real.
    [{ frameRate: 600, averageFrameRate: 29.4, variableFrameRate: true }, "29.4"],
    [{ frameRate: 60, averageFrameRate: 37.42, variableFrameRate: true }, "30/1"],
    [{ frameRate: null, averageFrameRate: null }, "30/1"],
  ])("%j → %s", (input, expected) => {
    expect(targetFrameRate({ variableFrameRate: false, ...input } as any).expr).toBe(expected);
  });
});

describe("filter chain", () => {
  it("drops frames, then scales, then pins yuv420p and square pixels for SDR", () => {
    const plan = planEncode(probe({ frameRate: 60, averageFrameRate: 60 }));
    expect(videoFilterChain(plan, plan.fallback, { fps: plan.fps })).toBe(
      "fps=30/1,scale=720:1280:flags=lanczos,format=yuv420p,setsar=1",
    );
  });

  it("tone-maps HDR after downscaling, passing explicit input colour properties", () => {
    const plan = planEncode(
      probe({ hdr: "hlg", colorTransfer: "arib-std-b67", colorPrimaries: "bt2020", colorSpace: "bt2020nc" }),
    );
    const chain = videoFilterChain(plan, plan.fallback, { fps: plan.fps });
    expect(chain).toContain("zscale=w=720:h=1280:f=lanczos:tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=limited:t=linear:p=bt2020");
    expect(chain.indexOf("zscale=w=720")).toBeLessThan(chain.indexOf("tonemap="));
    expect(chain).toContain("tonemap=tonemap=mobius:desat=0");
    expect(chain).toMatch(/zscale=t=bt709:m=bt709:r=limited,format=yuv420p,setsar=1$/);
  });

  it("falls back to BT.2020 when an HDR source leaves primaries/matrix unset", () => {
    const plan = planEncode(probe({ hdr: "pq", colorTransfer: "smpte2084", colorPrimaries: null, colorSpace: "unknown" }));
    expect(videoFilterChain(plan, plan.fallback)).toContain("tin=smpte2084:pin=bt2020:min=bt2020nc");
  });

  it("converts an explicit BT.601 SDR matrix to BT.709 but leaves untagged video alone", () => {
    const tagged = planEncode(probe({ colorSpace: "smpte170m" }));
    expect(videoFilterChain(tagged, tagged.fallback)).toContain("in_color_matrix=bt601:out_color_matrix=bt709");
    const untagged = planEncode(probe({ colorSpace: null }));
    expect(videoFilterChain(untagged, untagged.fallback)).not.toContain("in_color_matrix");
  });
});

describe("ffmpeg arguments", () => {
  const plan = planEncode(probe());

  it("MP4: H.264 High yuv420p BT.709, capped CRF, faststart, explicit container, metadata stripped", () => {
    const args = buildMp4Args("/in/a.mov", "/tmp/work/fallback.mp4", plan, { threads: 2 });
    expect(args).toEqual(expect.arrayContaining(["-map_metadata", "-1", "-map_chapters", "-1"]));
    expect(argValue(args, "-c:v")).toBe("libx264");
    expect(argValue(args, "-profile:v")).toBe("high");
    expect(argValue(args, "-pix_fmt")).toBe("yuv420p");
    expect(argValue(args, "-crf")).toBe("23");
    expect(argValue(args, "-maxrate")).toBe("2500k");
    expect(argValue(args, "-bufsize")).toBe("5000k");
    expect(argValue(args, "-color_trc")).toBe("bt709");
    expect(argValue(args, "-movflags")).toBe("+faststart");
    expect(argValue(args, "-f")).toBe("mp4");
    expect(argValue(args, "-threads")).toBe("2");
    expect(args.at(-1)).toBe("/tmp/work/fallback.mp4");
    // Timestamps must start at 0: make_zero shifted presentation by the B-frame delay.
    expect(args).not.toContain("-avoid_negative_ts");
  });

  it("aligns keyframes on 2s boundaries with scene-cut insertion disabled", () => {
    const args = buildMp4Args("/in/a.mov", "/out.mp4", plan, { threads: 1 });
    expect(argValue(args, "-g")).toBe("60");
    expect(argValue(args, "-keyint_min")).toBe("60");
    expect(argValue(args, "-sc_threshold")).toBe("0");
    expect(argValue(args, "-force_key_frames")).toBe("expr:gte(t,n_forced*2)");
  });

  it("drops the audio track instead of inventing one for a silent clip", () => {
    const silent = planEncode(probe({ hasAudio: false }));
    const args = buildMp4Args("/in/a.mov", "/out.mp4", silent, { threads: 1 });
    expect(args).toContain("-an");
    expect(args).not.toContain("0:a:0");
  });

  it("HLS: one decode split into every rendition with per-stream rate control and fMP4 segments", () => {
    const args = buildHlsArgs("/in/a.mov", "/tmp/work/hls", plan, { threads: 2, segmentSeconds: 4 });
    const graph = argValue(args, "-filter_complex");
    expect(graph).toContain("split=4[s0][s1][s2][s3]");
    expect(graph).toContain("[s0]scale=360:640:flags=lanczos,setsar=1[v0]");
    expect(graph).toContain("[s3]null[v3]");
    expect(argValue(args, "-maxrate:v:0")).toBe("700k");
    expect(argValue(args, "-maxrate:v:3")).toBe("4500k");
    expect(argValue(args, "-hls_segment_type")).toBe("fmp4");
    expect(argValue(args, "-hls_time")).toBe("4");
    expect(argValue(args, "-hls_playlist_type")).toBe("vod");
    expect(argValue(args, "-var_stream_map")).toBe(
      "v:0,a:0,name:360 v:1,a:1,name:540 v:2,a:2,name:720 v:3,a:3,name:1080",
    );
    expect(args.at(-1)).toBe("/tmp/work/hls/r%v/index.m3u8");
    // The master is authored separately, from the finished files.
    expect(args).not.toContain("-master_pl_name");
  });

  it("poster: seeks past the lead-in and picks a representative frame", () => {
    const args = buildPosterArgs("/in/a.mov", "/tmp/work/poster.jpg", plan, 10_000);
    expect(argValue(args, "-ss")).toBe("1.000");
    expect(argValue(args, "-vf")).toContain("thumbnail=30");
    expect(argValue(args, "-frames:v")).toBe("1");
    expect(buildPosterArgs("/in", "/out.jpg", plan, 800)[buildPosterArgs("/in", "/out.jpg", plan, 800).indexOf("-ss") + 1]).toBe("0.200");
  });

  it("only accepts segment lengths that are whole multiples of the GOP", () => {
    expect(hlsSegmentSeconds({})).toBe(2);
    expect(hlsSegmentSeconds({ MEDIA_HLS_SEGMENT_SECONDS: "4" })).toBe(4);
    expect(hlsSegmentSeconds({ MEDIA_HLS_SEGMENT_SECONDS: "6" })).toBe(6);
    expect(hlsSegmentSeconds({ MEDIA_HLS_SEGMENT_SECONDS: "3" })).toBe(2);
  });
});
