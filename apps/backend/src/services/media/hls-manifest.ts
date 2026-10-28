import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FFPROBE, MediaProcessingError, runMediaProcess } from "./media-process";
import type { EncodePlan, Rendition } from "./video-encoding";

/**
 * Master playlist authoring. ffmpeg can write one, but its BANDWIDTH is the configured
 * cap and it cannot know the real CODECS level, so the master is generated here from the
 * finished files: peak/average bandwidth from actual segment sizes, CODECS from the init
 * segment. It is written last, so a master only ever exists once everything it
 * references does.
 */

export interface MediaPlaylist {
  targetDuration: number;
  mapUri: string | null;
  segments: Array<{ uri: string; duration: number }>;
  ended: boolean;
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const playlist: MediaPlaylist = { targetDuration: 0, mapUri: null, segments: [], ended: false };
  let pendingDuration: number | null = null;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      playlist.targetDuration = Number(line.split(":")[1]) || 0;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      playlist.mapUri = line.match(/URI="([^"]+)"/)?.[1] ?? null;
    } else if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number.parseFloat(line.slice("#EXTINF:".length));
    } else if (line === "#EXT-X-ENDLIST") {
      playlist.ended = true;
    } else if (!line.startsWith("#") && pendingDuration !== null) {
      playlist.segments.push({ uri: line, duration: pendingDuration });
      pendingDuration = null;
    }
  }
  return playlist;
}

const H264_PROFILE_IDC: Record<string, number> = {
  Baseline: 0x42,
  "Constrained Baseline": 0x42,
  Main: 0x4d,
  High: 0x64,
};
const H264_CONSTRAINTS: Record<string, number> = {
  "Constrained Baseline": 0x40,
};

/** RFC 6381 codec string for an H.264 stream, e.g. High@3.1 → `avc1.64001f`. */
export function avcCodecString(profile: string | null | undefined, level: number | null | undefined): string {
  const profileIdc = H264_PROFILE_IDC[profile ?? ""] ?? 0x64;
  const constraints = H264_CONSTRAINTS[profile ?? ""] ?? 0;
  const levelIdc = Number.isFinite(level) && (level as number) > 0 ? (level as number) : 40;
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return `avc1.${hex(profileIdc)}${hex(constraints)}${hex(levelIdc)}`;
}

export interface VariantSummary {
  uri: string;
  width: number;
  height: number;
  frameRate: number;
  codecs: string;
  /** Peak segment bitrate, bits/s (HLS BANDWIDTH). */
  bandwidth: number;
  /** Mean bitrate over the whole rendition, bits/s (HLS AVERAGE-BANDWIDTH). */
  averageBandwidth: number;
  bytes: number;
  segmentCount: number;
}

export function buildMasterPlaylist(variants: VariantSummary[]): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (const variant of variants) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},AVERAGE-BANDWIDTH=${variant.averageBandwidth},` +
        `CODECS="${variant.codecs}",RESOLUTION=${variant.width}x${variant.height},` +
        `FRAME-RATE=${variant.frameRate.toFixed(3)}`,
      variant.uri,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function probeInitCodecs(initPath: string, hasAudio: boolean): Promise<string> {
  const { stdout } = await runMediaProcess(
    FFPROBE,
    ["-hide_banner", "-v", "error", "-print_format", "json", "-show_streams", initPath],
    { timeoutMs: 30_000 },
  );
  const streams = (JSON.parse(stdout).streams ?? []) as Array<{
    codec_type?: string;
    profile?: string;
    level?: number;
  }>;
  const video = streams.find((stream) => stream.codec_type === "video");
  const codecs = [avcCodecString(video?.profile, video?.level)];
  // Every rendition encodes AAC-LC.
  if (hasAudio) codecs.push("mp4a.40.2");
  return codecs.join(",");
}

async function summariseRendition(
  outputDir: string,
  rendition: Rendition,
  plan: EncodePlan,
  segmentSeconds: number,
): Promise<VariantSummary> {
  const directory = `r${rendition.name}`;
  const playlist = parseMediaPlaylist(await readFile(join(outputDir, directory, "index.m3u8"), "utf8"));
  if (!playlist.ended || playlist.segments.length === 0 || !playlist.mapUri) {
    throw new MediaProcessingError("encode_failed", `rendition ${rendition.name} playlist is incomplete`);
  }

  const initBytes = (await stat(join(outputDir, directory, playlist.mapUri))).size;
  let totalBytes = initBytes;
  let totalDuration = 0;
  let peak = 0;
  for (const segment of playlist.segments) {
    const bytes = (await stat(join(outputDir, directory, segment.uri))).size;
    totalBytes += bytes;
    totalDuration += segment.duration;
    // A short tail segment is noisy; peak is taken over segments of meaningful length.
    if (segment.duration >= segmentSeconds / 2 || playlist.segments.length === 1) {
      peak = Math.max(peak, (bytes * 8) / Math.max(segment.duration, 0.001));
    }
  }

  return {
    uri: `${directory}/index.m3u8`,
    width: rendition.width,
    height: rendition.height,
    frameRate: plan.fps.value,
    codecs: await probeInitCodecs(join(outputDir, directory, playlist.mapUri), plan.hasAudio),
    bandwidth: Math.ceil(peak),
    averageBandwidth: Math.ceil((totalBytes * 8) / Math.max(totalDuration, 0.001)),
    bytes: totalBytes,
    segmentCount: playlist.segments.length,
  };
}

/** Verifies every rendition and writes `master.m3u8`; returns the summaries in master order. */
export async function writeMasterPlaylist(
  outputDir: string,
  plan: EncodePlan,
  segmentSeconds: number,
): Promise<VariantSummary[]> {
  const variants: VariantSummary[] = [];
  for (const rendition of plan.masterOrder) {
    variants.push(await summariseRendition(outputDir, rendition, plan, segmentSeconds));
  }
  await writeFile(join(outputDir, "master.m3u8"), buildMasterPlaylist(variants), "utf8");
  return variants;
}
