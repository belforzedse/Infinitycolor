import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Realistic playback fixtures: pipeline-encoded normalized MP4, poster and fMP4 HLS
 * ladder per clip, built by apps/backend/scripts/media/build-playback-fixtures.ts with the
 * media worker's own encode plan — so browser tests play exactly what production serves.
 *
 * The committed 20 KB fixtures in fixtures/media prove codec behaviour but measure
 * nothing about startup (a 20 KB file is buffered after one round trip). These are
 * generated into .cache/ (gitignored) and reused across runs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = join(here, "..", "..", "backend");
// Outside test-results/, which Playwright wipes between runs.
export const VIDEO_FIXTURE_DIR = join(here, "..", ".cache", "video-fixtures");

export function ffmpegAvailable(): boolean {
  const ffmpeg = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
  const ffprobe = spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-hide_banner", "-version"], { stdio: "ignore" });
  return ffmpeg.status === 0 && ffprobe.status === 0;
}

export interface PipelineClip {
  id: string;
  /** Paths relative to VIDEO_FIXTURE_DIR. */
  mp4: string;
  webm: string;
  poster: string;
  hls: string;
}

export function ensurePipelineClips(
  count = 3,
  { segmentSeconds = 4, seconds = 10 }: { segmentSeconds?: number; seconds?: number } = {},
): PipelineClip[] {
  const result = spawnSync(
    join(backendDir, "node_modules", ".bin", "tsx"),
    [
      "scripts/media/build-playback-fixtures.ts",
      `--out=${VIDEO_FIXTURE_DIR}`,
      `--count=${count}`,
      `--seconds=${seconds}`,
      `--segment=${segmentSeconds}`,
    ],
    { cwd: backendDir, encoding: "utf8", timeout: 10 * 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(`building playback fixtures failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").pop()!) as PipelineClip[];
}
