import type { HdrTransfer, VideoProbe } from "./video-normalization";

/**
 * Deterministic encode planning: probe in, ffmpeg argument arrays out. Pure, so the
 * decisions that matter (sizes, frame rate, tone mapping, GOP alignment) are unit-tested
 * without running ffmpeg.
 *
 * Output profile: H.264 High / yuv420p / BT.709 SDR with AAC-LC stereo — the one
 * combination every browser and phone decodes. Rotation is physically applied (ffmpeg's
 * default autorotate) and the display matrix dropped, pixels are made square, and
 * nothing is ever upscaled or cropped: presentation cropping (a story's `object-fit`)
 * belongs to the UI.
 */

export interface LadderStep {
  shortEdge: number;
  crf: number;
  maxrateKbps: number;
}

/**
 * Short-form ladder by short edge (a portrait 720 rung is 720x1280). Capped CRF: easy
 * content lands well under the cap, busy content is held to it. Caps sit below Apple's
 * HLS Authoring Spec figures for 16:9 because these are phone-shot clips at ≤30 fps;
 * 2500k at 720 matches what the previous single-file pipeline produced in production.
 */
export const LADDER: readonly LadderStep[] = [
  { shortEdge: 360, crf: 24, maxrateKbps: 700 },
  { shortEdge: 540, crf: 23, maxrateKbps: 1400 },
  { shortEdge: 720, crf: 23, maxrateKbps: 2500 },
  { shortEdge: 1080, crf: 22, maxrateKbps: 4500 },
];

/** The progressive MP4 every client can fall back to. */
export const FALLBACK_SHORT_EDGE = 720;
/** Start rendition for players that take the first playlist entry (Safari native HLS). */
export const START_SHORT_EDGE = 540;
export const GOP_SECONDS = 2;
export const MAX_OUTPUT_FPS = 30;
export const AUDIO_BITRATE_KBPS = 128;
/** A source this close to a rung (e.g. 1072px against 1080) still gets it, at source size. */
const RUNG_TOLERANCE = 0.9;

/**
 * Default segment length: one GOP. hls.js cannot start before its first fragment has
 * arrived, so this is the startup cost. Measured on a 12 s clip (Chromium, real origin):
 * startup was 1.22 / 1.94 / 2.54 s for 2 / 4 / 6 s segments at 1.5 Mbps and 150 ms RTT, and
 * 373 / 481 / 567 ms at 10 Mbps and 40 ms. Total bytes were identical, since every segment
 * is whole GOPs either way; the price of 2 s is twice as many segment requests.
 */
export const DEFAULT_HLS_SEGMENT_SECONDS = 2;

export function hlsSegmentSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.MEDIA_HLS_SEGMENT_SECONDS);
  // Must be a whole multiple of the GOP so every segment starts on an aligned keyframe.
  if (Number.isInteger(value) && value >= GOP_SECONDS && value % GOP_SECONDS === 0) return value;
  return DEFAULT_HLS_SEGMENT_SECONDS;
}

export interface Rendition extends LadderStep {
  name: string;
  width: number;
  height: number;
}

export interface FrameRate {
  value: number;
  /** Exact form handed to ffmpeg (`30000/1001`), so NTSC rates do not drift. */
  expr: string;
}

export interface EncodePlan {
  display: { width: number; height: number };
  fps: FrameRate;
  gopFrames: number;
  hdr: HdrTransfer | null;
  hasAudio: boolean;
  /** Ascending by size. */
  renditions: Rendition[];
  fallback: Rendition;
  top: Rendition;
  /** Ordered for the master playlist: start rendition first, then ascending. */
  masterOrder: Rendition[];
  colorIn: ColorInput;
}

interface ColorInput {
  transfer: string;
  primaries: string;
  matrix: string;
  range: "limited" | "full";
  /** Set when an SDR source explicitly uses a BT.601 matrix that needs converting. */
  sdrMatrixFrom: "bt601" | null;
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const evenFloor = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/** Frame size with the given short edge, preserving the display aspect ratio. */
export function frameSizeForShortEdge(
  displayWidth: number,
  displayHeight: number,
  shortEdge: number,
): { width: number; height: number } {
  let width: number;
  let height: number;
  if (displayWidth <= displayHeight) {
    width = even(shortEdge);
    height = even((shortEdge * displayHeight) / displayWidth);
  } else {
    height = even(shortEdge);
    width = even((shortEdge * displayWidth) / displayHeight);
  }
  // Extreme aspect ratios (panoramas, tall screen captures) would otherwise produce a
  // frame far larger than the rung's pixel budget and push H.264 past common levels.
  const budget = shortEdge * shortEdge * (16 / 9) * 1.25;
  if (width * height > budget) {
    const factor = Math.sqrt(budget / (width * height));
    width = evenFloor(width * factor);
    height = evenFloor(height * factor);
  }
  return { width, height };
}

export function selectRenditions(displayWidth: number, displayHeight: number): Rendition[] {
  const sourceShort = Math.min(displayWidth, displayHeight);
  const renditions: Rendition[] = [];
  for (const step of LADDER) {
    if (sourceShort < step.shortEdge * RUNG_TOLERANCE) continue;
    const shortEdge = Math.min(step.shortEdge, evenFloor(sourceShort));
    if (renditions.some((rendition) => rendition.shortEdge === shortEdge)) continue;
    renditions.push({
      ...step,
      shortEdge,
      name: String(step.shortEdge),
      ...frameSizeForShortEdge(displayWidth, displayHeight, shortEdge),
    });
  }
  if (renditions.length === 0) {
    // Smaller than the bottom rung: one rendition at source size, never upscaled.
    const shortEdge = evenFloor(sourceShort);
    renditions.push({
      ...LADDER[0],
      shortEdge,
      name: String(shortEdge),
      ...frameSizeForShortEdge(displayWidth, displayHeight, shortEdge),
    });
  }
  return renditions;
}

const STANDARD_RATES: Array<[number, number]> = [
  [24000, 1001],
  [30000, 1001],
  [24, 1],
  [25, 1],
  [30, 1],
  [15, 1],
  [12, 1],
  [20, 1],
];

function snapToStandard(rate: number, tolerance: number): FrameRate | null {
  let best: { num: number; den: number; error: number } | null = null;
  for (const [num, den] of STANDARD_RATES) {
    const error = Math.abs(rate - num / den) / (num / den);
    if (error <= tolerance && (!best || error < best.error)) best = { num, den, error };
  }
  return best ? { value: best.num / best.den, expr: `${best.num}/${best.den}` } : null;
}

export function targetFrameRate(probe: Pick<
  VideoProbe,
  "frameRate" | "averageFrameRate" | "variableFrameRate"
>): FrameRate {
  // VFR phone captures report a container tick rate (e.g. 600/1) as r_frame_rate; the
  // average is the rate the viewer actually experiences.
  let base = probe.variableFrameRate ? probe.averageFrameRate : probe.frameRate;
  if (!base || base > 240) base = probe.averageFrameRate;
  if (!base || !Number.isFinite(base)) base = MAX_OUTPUT_FPS;

  if (base > MAX_OUTPUT_FPS + 0.5) {
    // 60→30, 50→25, 59.94→29.97, 120→30: an integer divisor keeps motion cadence even.
    // Anything else (a VFR screen capture averaging 37 fps) is simply capped.
    for (const divisor of [2, 3, 4]) {
      const candidate = base / divisor;
      if (candidate > MAX_OUTPUT_FPS + 0.5) continue;
      const snapped = snapToStandard(candidate, 0.01);
      if (snapped) return snapped;
    }
    return { value: MAX_OUTPUT_FPS, expr: `${MAX_OUTPUT_FPS}/1` };
  }

  const target = Math.max(5, base);
  const snapped = snapToStandard(target, 0.005);
  if (snapped) return snapped;
  const rounded = Math.round(target * 1000) / 1000;
  return { value: rounded, expr: String(rounded) };
}

const PRIMARIES = new Set(["bt709", "bt2020", "smpte170m", "bt470bg", "smpte432", "smpte431", "bt470m", "smpte240m", "film"]);
const MATRICES = new Set(["bt709", "bt2020nc", "bt2020c", "smpte170m", "bt470bg", "smpte240m", "fcc"]);
const BT601_MATRICES = new Set(["smpte170m", "bt470bg"]);

function colorInput(probe: VideoProbe): ColorInput {
  // Only values from a fixed allowlist reach the filter graph; anything else (including
  // "unknown") falls back to the standard for the dynamic range.
  const hdr = Boolean(probe.hdr);
  const primaries =
    probe.colorPrimaries && PRIMARIES.has(probe.colorPrimaries)
      ? probe.colorPrimaries
      : hdr
        ? "bt2020"
        : "bt709";
  const matrix =
    probe.colorSpace && MATRICES.has(probe.colorSpace)
      ? probe.colorSpace
      : hdr
        ? "bt2020nc"
        : "bt709";
  return {
    transfer: probe.hdr === "pq" ? "smpte2084" : probe.hdr === "hlg" ? "arib-std-b67" : "bt709",
    primaries,
    matrix,
    range: probe.colorRange === "pc" ? "full" : "limited",
    sdrMatrixFrom: !hdr && probe.colorSpace && BT601_MATRICES.has(probe.colorSpace) ? "bt601" : null,
  };
}

export function planEncode(probe: VideoProbe): EncodePlan {
  if (!probe.displayWidth || !probe.displayHeight) {
    throw new Error("planEncode requires a probe with display dimensions");
  }
  const renditions = selectRenditions(probe.displayWidth, probe.displayHeight);
  const fallback =
    [...renditions].reverse().find((rendition) => rendition.shortEdge <= FALLBACK_SHORT_EDGE) ??
    renditions[0];
  const top = renditions[renditions.length - 1];
  const start =
    [...renditions].reverse().find((rendition) => rendition.shortEdge <= START_SHORT_EDGE) ??
    renditions[0];
  const fps = targetFrameRate(probe);

  return {
    display: { width: probe.displayWidth, height: probe.displayHeight },
    fps,
    gopFrames: Math.max(1, Math.ceil(GOP_SECONDS * fps.value - 1e-6)),
    hdr: probe.hdr,
    hasAudio: probe.hasAudio,
    renditions,
    fallback,
    top,
    masterOrder: [start, ...renditions.filter((rendition) => rendition !== start)],
    colorIn: colorInput(probe),
  };
}

/**
 * Filter chain from the decoded (already auto-rotated) frames to one SDR yuv420p size.
 * Order matters for memory: frames are dropped to the target rate and scaled down to the
 * output size *before* HDR tone mapping, whose float RGB buffers are ~100 MB per 2160p
 * frame but ~25 MB at 1080p.
 */
export function videoFilterChain(
  plan: Pick<EncodePlan, "hdr" | "colorIn">,
  size: { width: number; height: number },
  { fps }: { fps?: FrameRate } = {},
): string {
  const filters: string[] = [];
  if (fps) filters.push(`fps=${fps.expr}`);

  if (plan.hdr) {
    const color = plan.colorIn;
    // Input properties are passed explicitly: zscale refuses to convert from an
    // "unknown" primaries/transfer, which phones and screen recorders often leave unset.
    filters.push(
      `zscale=w=${size.width}:h=${size.height}:f=lanczos` +
        `:tin=${color.transfer}:pin=${color.primaries}:min=${color.matrix}:rin=${color.range}` +
        `:t=linear:p=${color.primaries}:npl=100`,
      "format=gbrpf32le",
      "zscale=p=bt709",
      // Mobius keeps in-range tones linear and only rolls off highlights; it tracked the
      // SDR reference closest on HLG and PQ fixtures without clipping.
      "tonemap=tonemap=mobius:desat=0",
      "zscale=t=bt709:m=bt709:r=limited",
      "format=yuv420p",
    );
  } else {
    const matrix = plan.colorIn.sdrMatrixFrom
      ? `:in_color_matrix=${plan.colorIn.sdrMatrixFrom}:out_color_matrix=bt709`
      : "";
    const range = plan.colorIn.range === "full" ? ":in_range=full:out_range=limited" : "";
    filters.push(`scale=${size.width}:${size.height}:flags=lanczos${matrix}${range}`, "format=yuv420p");
  }
  filters.push("setsar=1");
  return filters.join(",");
}

const INPUT_ARGS = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y"];
// Strips GPS location, device make/model and any other container/stream tags a phone
// recorded; outputs are public URLs.
const STRIP_METADATA = ["-map_metadata", "-1", "-map_chapters", "-1"];
const SDR_TAGS = [
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-colorspace", "bt709",
  "-color_range", "tv",
];

export interface EncoderOptions {
  threads: number;
  preset?: string;
}

function gopArgs(plan: EncodePlan): string[] {
  return [
    "-g", String(plan.gopFrames),
    "-keyint_min", String(plan.gopFrames),
    "-sc_threshold", "0",
    // Keyframes on exact time boundaries, identical in every rendition, so HLS segments
    // align and a player can switch renditions at any segment boundary.
    "-force_key_frames", `expr:gte(t,n_forced*${GOP_SECONDS})`,
  ];
}

function audioArgs(plan: EncodePlan): string[] {
  if (!plan.hasAudio) return ["-an"];
  return [
    "-c:a", "aac",
    "-b:a", `${AUDIO_BITRATE_KBPS}k`,
    "-ac", "2",
    "-ar", "48000",
    // Fills gaps and drops overlaps against the timestamps so audio stays in sync with
    // CFR video even when the phone's audio clock drifted.
    "-af", "aresample=async=1:first_pts=0",
  ];
}

export function buildMp4Args(
  inputPath: string,
  outputPath: string,
  plan: EncodePlan,
  { threads, preset = "medium" }: EncoderOptions,
): string[] {
  const rendition = plan.fallback;
  return [
    ...INPUT_ARGS,
    "-i", inputPath,
    "-map", "0:v:0",
    ...(plan.hasAudio ? ["-map", "0:a:0"] : []),
    ...STRIP_METADATA,
    "-vf", videoFilterChain(plan, rendition, { fps: plan.fps }),
    "-fps_mode", "cfr",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", preset,
    "-pix_fmt", "yuv420p",
    "-crf", String(rendition.crf),
    "-maxrate", `${rendition.maxrateKbps}k`,
    "-bufsize", `${rendition.maxrateKbps * 2}k`,
    ...gopArgs(plan),
    "-threads", String(threads),
    ...SDR_TAGS,
    ...audioArgs(plan),
    "-movflags", "+faststart",
    // Explicit container: the output is a temporary name ffmpeg cannot map to a muxer.
    "-f", "mp4",
    outputPath,
  ];
}

export function posterSeekSeconds(durationMs: number | null): number {
  const seconds = (durationMs ?? 0) / 1000;
  // Past the fade-in/black lead that phones and editors often put at t=0.
  return Math.max(0, Math.min(1, seconds * 0.25));
}

/** Optional progressive VP9/Opus delivery, using the same normalized SDR frames. */
export function buildWebmArgs(inputPath: string, outputPath: string, plan: EncodePlan, { threads }: EncoderOptions): string[] {
  return [
    ...INPUT_ARGS, "-i", inputPath, "-map", "0:v:0",
    ...(plan.hasAudio ? ["-map", "0:a:0"] : []), ...STRIP_METADATA,
    "-vf", videoFilterChain(plan, plan.fallback, { fps: plan.fps }), "-fps_mode", "cfr",
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", "32", "-b:v", "0",
    "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-threads", String(threads),
    "-g", String(plan.gopFrames), ...SDR_TAGS,
    ...(plan.hasAudio ? ["-c:a", "libopus", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-af", "aresample=async=1:first_pts=0"] : ["-an"]),
    "-f", "webm", outputPath,
  ];
}

/**
 * The poster only has to cover the gap until the first decoded frame, and story rails
 * also use it as the avatar image, so it is sized to the start rendition (540 short
 * edge) at moderate JPEG quality: roughly half the bytes of a 720p q3 still, which on a
 * slow link is the difference between the poster arriving before the video or after.
 */
export function posterSize(plan: Pick<EncodePlan, "masterOrder">): { width: number; height: number } {
  const start = plan.masterOrder[0];
  return { width: start.width, height: start.height };
}

export function buildPosterArgs(
  inputPath: string,
  outputPath: string,
  plan: EncodePlan,
  durationMs: number | null,
): string[] {
  return [
    ...INPUT_ARGS,
    "-ss", posterSeekSeconds(durationMs).toFixed(3),
    "-i", inputPath,
    "-map", "0:v:0",
    ...STRIP_METADATA,
    // `thumbnail` picks the most representative of the next 30 frames rather than
    // whatever frame sits at the seek point, which is often mid-transition or black.
    "-vf", `${videoFilterChain(plan, posterSize(plan))},thumbnail=30,format=yuvj420p`,
    "-frames:v", "1",
    "-q:v", "5",
    "-update", "1",
    "-f", "image2",
    outputPath,
  ];
}

/**
 * One decode, split into every rendition, muxed as fMP4 HLS. Per-variant playlists,
 * init segments and media segments are written under `outputDir/r<name>/`; the master
 * playlist is written separately (see hls-manifest.ts) once every file exists.
 */
export function buildHlsArgs(
  inputPath: string,
  outputDir: string,
  plan: EncodePlan,
  { threads, preset = "medium", segmentSeconds }: EncoderOptions & { segmentSeconds: number },
): string[] {
  const count = plan.renditions.length;
  const splitLabels = plan.renditions.map((_, index) => `[s${index}]`).join("");
  const graph = [
    `[0:v:0]${videoFilterChain(plan, plan.top, { fps: plan.fps })},split=${count}${splitLabels}`,
    ...plan.renditions.map((rendition, index) =>
      rendition === plan.top
        ? `[s${index}]null[v${index}]`
        : `[s${index}]scale=${rendition.width}:${rendition.height}:flags=lanczos,setsar=1[v${index}]`,
    ),
  ].join(";");

  const maps: string[] = [];
  const perStream: string[] = [];
  plan.renditions.forEach((rendition, index) => {
    maps.push("-map", `[v${index}]`);
    if (plan.hasAudio) maps.push("-map", "0:a:0");
    perStream.push(
      `-crf:v:${index}`, String(rendition.crf),
      `-maxrate:v:${index}`, `${rendition.maxrateKbps}k`,
      `-bufsize:v:${index}`, `${rendition.maxrateKbps * 2}k`,
    );
  });
  const streamMap = plan.renditions
    .map((rendition, index) =>
      plan.hasAudio ? `v:${index},a:${index},name:${rendition.name}` : `v:${index},name:${rendition.name}`,
    )
    .join(" ");

  return [
    ...INPUT_ARGS,
    "-i", inputPath,
    ...STRIP_METADATA,
    "-filter_complex", graph,
    ...maps,
    "-fps_mode", "cfr",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", preset,
    "-pix_fmt", "yuv420p",
    ...perStream,
    ...gopArgs(plan),
    "-threads", String(threads),
    ...SDR_TAGS,
    ...audioArgs(plan),
    "-f", "hls",
    "-hls_time", String(segmentSeconds),
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4",
    "-hls_flags", "independent_segments",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", `${outputDir}/r%v/seg_%03d.m4s`,
    "-var_stream_map", streamMap,
    `${outputDir}/r%v/index.m3u8`,
  ];
}
