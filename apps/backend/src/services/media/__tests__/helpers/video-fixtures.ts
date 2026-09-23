import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Representative phone/browser uploads, generated with ffmpeg at test time rather than
 * committed as binaries. Each is a few seconds of synthetic motion with the property that
 * broke playback in production: HEVC + rotation matrix + HLG (iPhone), VFR, no audio,
 * 4K60, odd dimensions, non-square pixels, truncation.
 */

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export function ffmpegAvailable(): boolean {
  const ffmpeg = spawnSync(FFMPEG, ["-hide_banner", "-version"], { stdio: "ignore" });
  const ffprobe = spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-hide_banner", "-version"], { stdio: "ignore" });
  return ffmpeg.status === 0 && ffprobe.status === 0;
}

function ffmpeg(args: string[]): void {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`fixture generation failed: ffmpeg ${args.join(" ")}\n${result.stderr}`);
  }
}

const video = (size: string, rate: number, seconds: number) => [
  "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate},noise=alls=12:allf=t`,
  "-t", String(seconds),
];
const tone = (seconds: number, layout = "mono") => [
  "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100,aformat=channel_layouts=${layout}`,
  "-t", String(seconds),
];

export interface Fixture {
  name: string;
  /** Upload file name (the row's hash + ext). */
  file: string;
  mime: string;
}

export const FIXTURES = {
  h264: { name: "h264", file: "h264_plain.mp4", mime: "video/mp4" },
  iphoneHlg: { name: "iphone-hlg", file: "iphone_hlg_portrait.mov", mime: "video/quicktime" },
  vfr: { name: "vfr", file: "vfr_screen.mp4", mime: "video/mp4" },
  silentWebm: { name: "silent-webm", file: "silent_vp9.webm", mime: "video/webm" },
  landscape4k60: { name: "landscape-4k60", file: "landscape_4k60.mp4", mime: "video/mp4" },
  odd: { name: "odd-dimensions", file: "odd_886x1919.mov", mime: "video/quicktime" },
  anamorphic: { name: "anamorphic", file: "anamorphic_sar43.mp4", mime: "video/mp4" },
  truncatedMoovAtEnd: { name: "truncated-moov-end", file: "truncated_moov_end.mp4", mime: "video/mp4" },
  truncatedFaststart: { name: "truncated-faststart", file: "truncated_faststart.mp4", mime: "video/mp4" },
} satisfies Record<string, Fixture>;

export function generateFixtures(dir: string): void {
  const out = (fixture: Fixture) => join(dir, fixture.file);

  // Ordinary Android/browser MP4: H.264/AAC, moov at the end (no faststart).
  ffmpeg([...video("1280x720", 30, 3), ...tone(3, "stereo"), "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out(FIXTURES.h264)]);

  // iPhone: HEVC Main10 in QuickTime, stored landscape with a rotation matrix, HLG BT.2020,
  // mono audio. The SDR test pattern is converted into real HLG so tone mapping has
  // something meaningful to undo.
  const hlgFlat = join(dir, "_hlg_flat.mov");
  ffmpeg([...video("1920x1080", 30, 3), ...tone(3),
    "-vf", "format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv," +
      "zscale=t=linear:npl=100,format=gbrpf32le," +
      "zscale=p=bt2020:t=arib-std-b67:m=bt2020nc:r=tv:npl=100,format=yuv420p10le",
    "-c:v", "libx265", "-preset", "ultrafast",
    "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
    "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc",
    "-tag:v", "hvc1", "-c:a", "aac", "-shortest", hlgFlat]);
  // Location and device tags as an iPhone writes them; outputs must not carry them.
  ffmpeg(["-display_rotation", "90", "-i", hlgFlat, "-c", "copy",
    "-metadata", "location=+35.6892+051.3890/", "-metadata", "make=Apple",
    "-metadata", "model=iPhone 15 Pro", out(FIXTURES.iphoneHlg)]);

  // Screen recording: frames dropped irregularly, variable timestamps preserved.
  ffmpeg([...video("1080x1920", 60, 3), ...tone(3), "-vf", "select='not(eq(mod(n\\,3)\\,0))'",
    "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", out(FIXTURES.vfr)]);

  // Browser MediaRecorder-style WebM with no audio track.
  ffmpeg([...video("640x360", 25, 2), "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
    "-b:v", "500k", out(FIXTURES.silentWebm)]);

  // 4K60 landscape, one second.
  ffmpeg([...video("3840x2160", 60, 1), ...tone(1, "stereo"), "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out(FIXTURES.landscape4k60)]);

  // Odd frame size (common in screen captures). 4:4:4 so the fixture itself can be encoded.
  ffmpeg([...video("886x1919", 30, 2), ...tone(2), "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv444p", "-c:a", "aac", "-shortest", out(FIXTURES.odd)]);

  // Anamorphic: 1440x1080 coded with 4:3 pixels, displayed 1920x1080.
  ffmpeg([...video("1440x1080", 25, 2), ...tone(2), "-vf", "setsar=4/3", "-c:v", "libx264",
    "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out(FIXTURES.anamorphic)]);

  // Truncated uploads: an interrupted phone upload cut at 60%.
  const truncate = (source: string, target: string) => {
    const bytes = readFileSync(source);
    writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  };
  truncate(out(FIXTURES.h264), out(FIXTURES.truncatedMoovAtEnd));
  const faststart = join(dir, "_faststart.mp4");
  ffmpeg([...video("1280x720", 30, 4), ...tone(4, "stereo"), "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", faststart]);
  truncate(faststart, out(FIXTURES.truncatedFaststart));
}

/** Mean luma and saturation of one decoded frame (signalstats), for poster/tone checks. */
export function frameStats(path: string, seekSeconds = 0): { yavg: number; satavg: number } {
  const result = spawnSync(
    FFMPEG,
    ["-hide_banner", "-nostdin", ...(seekSeconds > 0 ? ["-ss", String(seekSeconds)] : []), "-i", path, "-vf",
      "signalstats,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const read = (key: string) => Number(result.stdout.match(new RegExp(`${key}=([\\d.]+)`))?.[1]);
  return { yavg: read("lavfi.signalstats.YAVG"), satavg: read("lavfi.signalstats.SATAVG") };
}

/** Keyframe presentation times of the first video stream. */
export function keyframeTimes(path: string): number[] {
  const result = spawnSync(
    process.env.FFPROBE_PATH || "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time",
      "-of", "csv=p=0", path],
    { encoding: "utf8" },
  );
  return result.stdout
    .split(/\s+/)
    .map((value) => Number.parseFloat(value.replace(/,$/, "")))
    .filter((value) => Number.isFinite(value));
}

export function formatTags(path: string): Record<string, string> {
  const result = spawnSync(
    process.env.FFPROBE_PATH || "ffprobe",
    ["-v", "error", "-show_entries", "format_tags:stream_tags:stream_side_data", "-of", "json", path],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(result.stdout || "{}");
  return { ...(parsed.format?.tags ?? {}), side: JSON.stringify(parsed.streams?.map((s: any) => s.side_data_list ?? null) ?? []) };
}
