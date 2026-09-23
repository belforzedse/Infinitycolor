import { open } from "node:fs/promises";
import {
  FFMPEG,
  FFPROBE,
  FfmpegUnavailableError,
  MediaProcessingError,
  runMediaProcess,
} from "./media-process";

/**
 * Probing and validation for uploaded video.
 *
 * Uploads are whatever a phone or browser produced: HEVC in QuickTime, rotation stored as
 * a display matrix, variable frame rate, HLG/PQ HDR, non-square pixels, odd dimensions.
 * The production catalogue was almost entirely HEVC `.mov` at ~11 Mbps with the `moov`
 * atom at the end, which Chromium builds without platform HEVC parse and then decode
 * nothing — a black frame with audio and no `error` event.
 *
 * Nothing here trusts the extension or the browser-supplied MIME type: the encode plan is
 * derived from what ffprobe reports about the actual streams.
 */

export { FfmpegUnavailableError, MediaProcessingError } from "./media-process";

export type HdrTransfer = "hlg" | "pq";

export interface VideoProbe {
  containerFormats: string[];
  videoCodec: string | null;
  videoProfile: string | null;
  audioCodec: string | null;
  /** Coded frame size as stored in the stream. */
  width: number | null;
  height: number | null;
  /** Size as the viewer sees it: rotation applied and non-square pixels expanded. */
  displayWidth: number | null;
  displayHeight: number | null;
  /** Clockwise display rotation normalised to 0/90/180/270. */
  rotation: number;
  /** Sample (pixel) aspect ratio as a number; 1 for square pixels. */
  sampleAspectRatio: number;
  frameRate: number | null;
  averageFrameRate: number | null;
  variableFrameRate: boolean;
  pixelFormat: string | null;
  bitDepth: number | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorSpace: string | null;
  colorRange: string | null;
  hdr: HdrTransfer | null;
  dolbyVisionProfile: number | null;
  hasAudio: boolean;
  audioChannels: number | null;
  durationMs: number | null;
  bitRate: number | null;
  /** True when the `moov` atom precedes `mdat`, i.e. playback can start before download. */
  fastStart: boolean;
}

export interface ProbeLimits {
  minDurationMs: number;
  maxDurationMs: number;
  maxDimension: number;
}

export function readProbeLimits(env: NodeJS.ProcessEnv = process.env): ProbeLimits {
  const maxSeconds = Number(env.MEDIA_MAX_DURATION_S);
  return {
    minDurationMs: 300,
    maxDurationMs: (Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : 600) * 1000,
    maxDimension: 8192,
  };
}

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await runMediaProcess(FFMPEG, ["-version"], { timeoutMs: 10_000 });
    await runMediaProcess(FFPROBE, ["-version"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

let filterList: Promise<string> | null = null;

/** Whether this ffmpeg build has a filter (e.g. `zscale`, needed for HDR tone mapping). */
export async function hasFfmpegFilter(name: string): Promise<boolean> {
  filterList ??= runMediaProcess(FFMPEG, ["-hide_banner", "-filters"], { timeoutMs: 10_000 })
    .then(({ stdout }) => stdout)
    .catch((error) => {
      filterList = null;
      throw error;
    });
  const list = await filterList;
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(list);
}

/**
 * Reads the top-level atoms to see whether `moov` precedes `mdat`. ffprobe does not report
 * this, and it is the difference between a video that starts playing after a small range
 * request and one that needs the tail of a 50 MB file first.
 */
export async function hasFastStart(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const header = Buffer.alloc(16);
    let offset = 0;
    const { size } = await handle.stat();

    for (let index = 0; index < 16 && offset < size; index += 1) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;
      let atomSize = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      if (atomSize === 1) atomSize = Number(header.readBigUInt64BE(8));
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (atomSize <= 0) return false;
      offset += atomSize;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  color_range?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_aspect_ratio?: string;
  channels?: number;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number; dv_profile?: number }>;
  disposition?: { attached_pic?: number };
}

export interface FfprobeOutput {
  format?: { format_name?: string; duration?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

export function parseRational(value: string | undefined | null): number | null {
  if (!value) return null;
  const [num, den] = value.split(/[/:]/).map(Number);
  if (!Number.isFinite(num)) return null;
  if (den === undefined) return num > 0 ? num : null;
  if (!Number.isFinite(den) || den === 0 || num === 0) return null;
  const result = num / den;
  return result > 0 ? result : null;
}

function normaliseRotation(stream: FfprobeStream): number {
  const fromSideData = stream.side_data_list?.find((entry) => typeof entry.rotation === "number")?.rotation;
  // ffmpeg < 5 exposed rotation as a `rotate` tag instead of display-matrix side data.
  const raw = fromSideData ?? Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  const quarter = Math.round(raw / 90) * 90;
  return ((quarter % 360) + 360) % 360;
}

function hdrTransfer(transfer: string | null): HdrTransfer | null {
  if (transfer === "arib-std-b67") return "hlg";
  if (transfer === "smpte2084") return "pq";
  return null;
}

function bitDepthOf(stream: FfprobeStream): number | null {
  const raw = Number(stream.bits_per_raw_sample);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const match = stream.pix_fmt?.match(/p(\d{2})(?:le|be)?$/);
  if (match) return Number(match[1]);
  return stream.pix_fmt ? 8 : null;
}

/** Pure half of {@link probeVideo}; exported for unit tests. */
export function interpretProbe(parsed: FfprobeOutput, fastStart: boolean): VideoProbe {
  const streams = parsed.streams ?? [];
  // Cover art in audio files and some phone exports shows up as a single-frame "video"
  // stream; it is not the video.
  const video = streams.find(
    (stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const audio = streams.find((stream) => stream.codec_type === "audio");

  const rotation = video ? normaliseRotation(video) : 0;
  const sampleAspectRatio = parseRational(video?.sample_aspect_ratio) ?? 1;
  let displayWidth: number | null = null;
  let displayHeight: number | null = null;
  if (video?.width && video?.height) {
    displayWidth = Math.round(video.width * sampleAspectRatio);
    displayHeight = video.height;
    if (rotation === 90 || rotation === 270) {
      [displayWidth, displayHeight] = [displayHeight, displayWidth];
    }
  }

  const frameRate = parseRational(video?.r_frame_rate);
  const averageFrameRate = parseRational(video?.avg_frame_rate);
  const variableFrameRate = Boolean(
    frameRate && averageFrameRate && Math.abs(frameRate - averageFrameRate) / averageFrameRate > 0.02,
  );

  const colorTransfer = video?.color_transfer ?? null;
  const dolbyVision = video?.side_data_list?.find(
    (entry) => typeof entry.dv_profile === "number",
  )?.dv_profile;

  const formatDuration = Number(parsed.format?.duration);
  const streamDuration = Number(video?.duration);
  const durationSeconds =
    Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : streamDuration;

  return {
    containerFormats: (parsed.format?.format_name ?? "").split(",").filter(Boolean),
    videoCodec: video?.codec_name ?? null,
    videoProfile: video?.profile ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    displayWidth,
    displayHeight,
    rotation,
    sampleAspectRatio,
    frameRate,
    averageFrameRate,
    variableFrameRate,
    pixelFormat: video?.pix_fmt ?? null,
    bitDepth: video ? bitDepthOf(video) : null,
    colorPrimaries: video?.color_primaries ?? null,
    colorTransfer,
    colorSpace: video?.color_space ?? null,
    colorRange: video?.color_range ?? null,
    hdr: hdrTransfer(colorTransfer),
    dolbyVisionProfile: typeof dolbyVision === "number" ? dolbyVision : null,
    hasAudio: Boolean(audio),
    audioChannels: audio?.channels ?? null,
    durationMs:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.round(durationSeconds * 1000)
        : null,
    bitRate: Number(parsed.format?.bit_rate) || null,
    fastStart,
  };
}

export async function probeVideo(filePath: string): Promise<VideoProbe> {
  let stdout: string;
  try {
    ({ stdout } = await runMediaProcess(
      FFPROBE,
      [
        "-hide_banner",
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { timeoutMs: 60_000 },
    ));
  } catch (error) {
    if (error instanceof MediaProcessingError && error.code !== "decode_failed" && error.code !== "encode_failed") {
      throw error;
    }
    // ffprobe failing on the file itself means the upload is not a readable video.
    throw new MediaProcessingError(
      "probe_failed",
      "the file could not be read as a video",
      error instanceof MediaProcessingError ? error.detail : String(error),
    );
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new MediaProcessingError("probe_failed", "ffprobe returned unreadable output");
  }
  return interpretProbe(parsed, await hasFastStart(filePath));
}

/** Rejects inputs the product should not accept, before any CPU is spent on them. */
export function validateProbe(probe: VideoProbe, limits: ProbeLimits = readProbeLimits()): void {
  if (!probe.videoCodec || !probe.displayWidth || !probe.displayHeight) {
    throw new MediaProcessingError("no_video_stream", "the file has no video stream");
  }
  if (probe.durationMs === null || probe.durationMs < limits.minDurationMs) {
    throw new MediaProcessingError("probe_failed", "the video has no usable duration");
  }
  if (probe.durationMs > limits.maxDurationMs) {
    throw new MediaProcessingError(
      "duration_exceeded",
      `the video is longer than ${Math.round(limits.maxDurationMs / 1000)}s`,
    );
  }
  if (Math.max(probe.displayWidth, probe.displayHeight) > limits.maxDimension) {
    throw new MediaProcessingError(
      "dimensions_exceeded",
      `the video is larger than ${limits.maxDimension}px`,
    );
  }
}
