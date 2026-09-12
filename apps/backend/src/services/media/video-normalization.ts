import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

/**
 * Web-safe video normalization.
 *
 * Story media is uploaded as-is, and in practice that means whatever a phone produced:
 * the production catalogue is almost entirely HEVC in a QuickTime container at ~11 Mbps,
 * with the `moov` atom at the end of the file. Chromium builds without platform HEVC
 * parse those happily and then decode nothing — a black frame with audio and no `error`
 * event — so no amount of client-side handling can make them play.
 *
 * This module is the ffmpeg half of the fix: probe a file, decide whether it is safe to
 * serve directly, and if not, transcode it to progressive H.264/AAC MP4 with the moov
 * atom at the front. It is intentionally free of Strapi so the queue job, the backfill
 * script and the unit tests can all share it.
 */

/** Video codecs every current browser can decode from a progressive MP4/WebM. */
const WEB_SAFE_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
/** Containers browsers will accept for progressive playback. */
const WEB_SAFE_CONTAINERS = new Set(["mp4", "webm", "matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2"]);
/** Container brands that are really QuickTime rather than MP4, despite the shared demuxer. */
const QUICKTIME_MIMES = new Set(["video/quicktime", "video/x-quicktime"]);

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export interface VideoProbe {
  containerFormats: string[];
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  bitRate: number | null;
  /** True when the `moov` atom precedes `mdat`, i.e. playback can start before download. */
  fastStart: boolean;
}

export interface NormalizationDecision {
  needed: boolean;
  /** Human-readable reasons, surfaced by the backfill script's dry run. */
  reasons: string[];
}

export class FfmpegUnavailableError extends Error {
  constructor(binary: string) {
    super(
      `${binary} is not available. The backend image installs it in the runner stage; ` +
        `set FFMPEG_PATH/FFPROBE_PATH when running outside that image.`,
    );
    this.name = "FfmpegUnavailableError";
  }
}

function run(
  binary: string,
  args: string[],
  { timeoutMs = 15 * 60_000 }: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // Bound the wall time: a malformed file can otherwise keep ffmpeg spinning forever
    // and wedge the worker.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${binary} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new FfmpegUnavailableError(binary));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${binary} exited with ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await run(FFMPEG, ["-version"], { timeoutMs: 10_000 });
    await run(FFPROBE, ["-version"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
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

export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await run(
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
  );

  const parsed = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string; bit_rate?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
    }>;
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(parsed.format?.duration);

  return {
    containerFormats: (parsed.format?.format_name ?? "").split(",").filter(Boolean),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationMs:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.round(durationSeconds * 1000)
        : null,
    bitRate: Number(parsed.format?.bit_rate) || null,
    fastStart: await hasFastStart(filePath),
  };
}

export function decideNormalization(
  probe: VideoProbe,
  { mime, extension }: { mime?: string | null; extension?: string | null } = {},
): NormalizationDecision {
  const reasons: string[] = [];

  if (!probe.videoCodec) {
    reasons.push("no video stream detected");
  } else if (!WEB_SAFE_VIDEO_CODECS.has(probe.videoCodec)) {
    reasons.push(`video codec ${probe.videoCodec} is not decodable in all browsers`);
  }

  if (probe.audioCodec && !["aac", "opus", "vorbis", "mp3"].includes(probe.audioCodec)) {
    reasons.push(`audio codec ${probe.audioCodec} is not playable in all browsers`);
  }

  // A QuickTime container is served as video/quicktime, which no browser advertises
  // support for even when the codecs inside are fine.
  if (mime && QUICKTIME_MIMES.has(mime.toLowerCase())) {
    reasons.push(`container is served as ${mime}`);
  }
  if (extension && extension.toLowerCase() === ".mov") {
    reasons.push("file extension is .mov");
  }
  if (probe.containerFormats.length && !probe.containerFormats.some((format) =>
    WEB_SAFE_CONTAINERS.has(format) || format === "mp4" || format === "webm")) {
    reasons.push(`container ${probe.containerFormats.join(",")} is not a progressive web container`);
  }

  if (!probe.fastStart && probe.videoCodec !== "vp9" && probe.videoCodec !== "vp8") {
    reasons.push("moov atom is not at the front (no fast start)");
  }

  return { needed: reasons.length > 0, reasons };
}

export interface TranscodeOptions {
  /** Longest edge of the output; portrait story media ends up 720x1280. */
  maxHeight?: number;
  crf?: number;
  maxBitrateKbps?: number;
}

/**
 * Transcodes to the baseline every browser handles: progressive MP4, H.264 High, yuv420p,
 * AAC audio, `moov` at the front. Deliberately not HLS/DASH — story clips are seconds
 * long and a normalized progressive MP4 removes the actual defect.
 */
export function buildTranscodeArgs(
  inputPath: string,
  outputPath: string,
  { maxHeight = 1280, crf = 23, maxBitrateKbps = 3000 }: TranscodeOptions = {},
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    // Keep audio only when the source has it; `?` makes the mapping optional.
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.0",
    "-pix_fmt", "yuv420p",
    // -2 keeps the width even (H.264 requires it) while preserving the aspect ratio, and
    // `min(ih,maxHeight)` avoids upscaling anything already smaller.
    "-vf", `scale=-2:'min(ih,${maxHeight})'`,
    "-crf", String(crf),
    "-maxrate", `${maxBitrateKbps}k`,
    "-bufsize", `${maxBitrateKbps * 2}k`,
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-movflags", "+faststart",
    // Explicit container: ffmpeg otherwise picks the muxer from the output file
    // extension, and the caller writes to a temporary `*.partial` name before renaming
    // atomically — which ffmpeg cannot map to a format.
    "-f", "mp4",
    outputPath,
  ];
}

export async function transcodeToWebSafeMp4(
  inputPath: string,
  outputPath: string,
  options: TranscodeOptions = {},
): Promise<void> {
  await run(FFMPEG, buildTranscodeArgs(inputPath, outputPath, options));
}
