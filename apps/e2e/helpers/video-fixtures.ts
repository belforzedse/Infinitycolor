import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
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
  const ffmpeg = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-version"],
    { stdio: "ignore" },
  );
  const ffprobe = spawnSync(
    process.env.FFPROBE_PATH || "ffprobe",
    ["-hide_banner", "-version"],
    { stdio: "ignore" },
  );
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
  {
    segmentSeconds = 4,
    seconds = 10,
  }: { segmentSeconds?: number; seconds?: number } = {},
): PipelineClip[] {
  mkdirSync(VIDEO_FIXTURE_DIR, { recursive: true });
  const lock = join(VIDEO_FIXTURE_DIR, ".build-lock");
  const deadline = Date.now() + 10 * 60_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  // Browser projects share this cache. Concurrent FFmpeg writers corrupt otherwise
  // valid MP4s, so the complete fixture build and cache check have one owner.
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(
          "Timed out waiting for the local media fixture builder",
        );
      Atomics.wait(pause, 0, 0, 100);
    }
  }
  try {
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
      throw new Error(
        `building playback fixtures failed:\n${result.stderr || result.stdout}`,
      );
    }
    return JSON.parse(
      result.stdout.trim().split("\n").pop()!,
    ) as PipelineClip[];
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
