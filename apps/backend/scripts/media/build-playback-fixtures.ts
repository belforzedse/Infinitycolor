/**
 * Builds realistic playback fixtures with the media pipeline's own encode plan and ffmpeg
 * arguments: a normalized faststart MP4, a poster and an fMP4 HLS ladder per clip. Used by
 * the browser playback/perf specs in apps/e2e (via tsx), so they play exactly what the
 * media worker publishes. Local/dev tool only; writes nothing outside --out.
 *
 *   tsx scripts/media/build-playback-fixtures.ts --out=/tmp/fixtures --count=3 --seconds=10 --segment=4
 *
 * Prints a JSON manifest of the clips on stdout.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeMasterPlaylist } from "../../src/services/media/hls-manifest";
import { FFMPEG } from "../../src/services/media/media-process";
import { buildHlsArgs, buildMp4Args, buildWebmArgs, buildPosterArgs, planEncode } from "../../src/services/media/video-encoding";
import { probeVideo } from "../../src/services/media/video-normalization";

const HUES = [0, 120, 240, 60, 300];

function arg(name: string, fallback: string): string {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

function ffmpeg(args: string[]): void {
  const result = spawnSync(FFMPEG, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}\n${result.stderr}`);
}

async function main() {
  const out = resolve(arg("out", "playback-fixtures"));
  const count = Number(arg("count", "3"));
  const seconds = Number(arg("seconds", "10"));
  const segmentSeconds = Number(arg("segment", "4"));
  await mkdir(out, { recursive: true });

  const clips = [];
  for (let index = 0; index < count; index += 1) {
    const id = `clip${index}-${seconds}s-seg${segmentSeconds}`;
    const clip = { id, mp4: `${id}.mp4`, webm: `${id}.webm`, poster: `${id}.jpg`, hls: `${id}-hls/master.m3u8` };
    clips.push(clip);
    if (existsSync(join(out, clip.hls)) && existsSync(join(out, clip.mp4)) && existsSync(join(out, clip.poster)) && existsSync(join(out, clip.webm))) {
      continue;
    }

    // Phone-like source: 1080x1920 portrait at 30 fps with temporal noise, so the encoder
    // has real work and the output lands near the production bitrate caps.
    const source = join(out, `${id}-source.mp4`);
    ffmpeg([
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30,hue=h=${HUES[index % HUES.length]},noise=alls=18:allf=t`,
      "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
      "-t", String(seconds), "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ]);
    const probe = await probeVideo(source);
    const plan = planEncode(probe);
    ffmpeg(buildMp4Args(source, join(out, clip.mp4), plan, { threads: 4, preset: "veryfast" }));
    ffmpeg(buildWebmArgs(source, join(out, clip.webm), plan, { threads: 4 }));
    ffmpeg(buildPosterArgs(source, join(out, clip.poster), plan, probe.durationMs));
    const hlsDir = join(out, `${id}-hls`);
    await rm(hlsDir, { recursive: true, force: true });
    await mkdir(hlsDir, { recursive: true });
    ffmpeg(buildHlsArgs(source, hlsDir, plan, { threads: 4, preset: "veryfast", segmentSeconds }));
    await writeMasterPlaylist(hlsDir, plan, segmentSeconds);
    await rm(source, { force: true });
  }
  process.stdout.write(`${JSON.stringify(clips)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
