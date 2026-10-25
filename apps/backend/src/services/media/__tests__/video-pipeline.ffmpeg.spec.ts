/**
 * End-to-end pipeline runs against real ffmpeg on generated phone/browser fixtures.
 * Skipped when ffmpeg/ffprobe are not installed (e.g. the CI unit-test image).
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { FileRow } from "../video-metadata";
import { createMemoryVideoStore, type MemoryVideoStore } from "./helpers/memory-video-store";
import {
  FIXTURES,
  ffmpegAvailable,
  formatTags,
  frameStats,
  generateFixtures,
  keyframeTimes,
  type Fixture,
} from "./helpers/video-fixtures";

let mockStore: MemoryVideoStore;

jest.mock("../video-metadata", () => {
  const actual = jest.requireActual("../video-metadata");
  return {
    ...actual,
    readFileRow: (...args: any[]) => (mockStore.readFileRow as any)(...args),
    claimLease: (...args: any[]) => (mockStore.claimLease as any)(...args),
    renewLease: (...args: any[]) => (mockStore.renewLease as any)(...args),
    releaseLease: (...args: any[]) => (mockStore.releaseLease as any)(...args),
    writeVideoState: (...args: any[]) => (mockStore.writeVideoState as any)(...args),
  };
});
jest.mock("@sentry/node", () => ({ captureMessage: jest.fn() }));

import * as mediaProcess from "../media-process";
import { parseMediaPlaylist } from "../hls-manifest";
import { probeVideo } from "../video-normalization";
import { processVideoFile } from "../video-pipeline";
import { snapshotRow } from "../video-metadata";

const describeWithFfmpeg = ffmpegAvailable() ? describe : describe.skip;

describeWithFfmpeg("video pipeline (real ffmpeg)", () => {
  jest.setTimeout(240_000);

  let uploads: string;
  const strapi = {
    db: { connection: { raw: jest.fn(async () => ({ rows: [] })) }, query: jest.fn() },
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };

  beforeAll(() => {
    uploads = mkdtempSync(join(tmpdir(), "media-pipeline-"));
    generateFixtures(uploads);
  });

  afterAll(() => {
    if (uploads) rmSync(uploads, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockStore = createMemoryVideoStore();
  });

  function rowFor(fixture: Fixture, id: number, overrides: Partial<FileRow> = {}): FileRow {
    const extension = extname(fixture.file);
    return {
      id,
      name: fixture.file,
      hash: fixture.file.slice(0, -extension.length),
      ext: extension,
      mime: fixture.mime,
      size: statSync(join(uploads, fixture.file)).size / 1024,
      url: `/uploads/${fixture.file}`,
      previewUrl: null,
      width: null,
      height: null,
      video: null,
      ...overrides,
    };
  }

  async function processFixture(fixture: Fixture, id: number, options: { hlsEnabled?: boolean } = {}) {
    mockStore.put(rowFor(fixture, id));
    return processVideoFile(id, {
      strapi,
      uploadsDir: uploads,
      hlsEnabled: options.hlsEnabled ?? true,
      threads: 4,
      jobId: `test-${id}`,
    });
  }

  const onDisk = (url: string) => join(uploads, url.replace(/^\/uploads\//, ""));

  async function expectPlayableRow(id: number, size: { width: number; height: number }, { audio = true } = {}) {
    const row = mockStore.get(id)!;
    expect(row.mime).toBe("video/mp4");
    expect(row.ext).toBe(".mp4");
    expect(row.url).toMatch(/^\/uploads\/[\w.-]+_v1-[0-9a-f]{8}\.mp4$/);
    expect(row.hash && `/uploads/${row.hash}${row.ext}`).toBe(row.url);
    expect(row.video?.lease ?? null).toBeNull();

    const mp4 = await probeVideo(onDisk(row.url!));
    expect(mp4.videoCodec).toBe("h264");
    expect(mp4.pixelFormat).toBe("yuv420p");
    expect(mp4.rotation).toBe(0);
    expect(mp4.sampleAspectRatio).toBe(1);
    expect({ width: mp4.displayWidth, height: mp4.displayHeight }).toEqual(size);
    expect(mp4.colorTransfer === null || mp4.colorTransfer === "bt709").toBe(true);
    expect(mp4.fastStart).toBe(true);
    expect(mp4.averageFrameRate!).toBeLessThanOrEqual(30.01);
    expect(mp4.variableFrameRate).toBe(false);
    expect(mp4.hasAudio).toBe(audio);
    expect(row.width).toBe(size.width);
    expect(row.height).toBe(size.height);

    // Keyframes land on the 2-second grid the HLS renditions share.
    for (const time of keyframeTimes(onDisk(row.url!))) {
      expect(Math.abs(time / 2 - Math.round(time / 2))).toBeLessThan(0.03);
    }

    // Poster: exists, is the row's previewUrl, and is not a black frame.
    expect(row.previewUrl).toBe(row.video?.output?.poster?.url);
    const poster = onDisk(row.previewUrl!);
    expect(statSync(poster).size).toBeGreaterThan(1000);
    expect(frameStats(poster).yavg).toBeGreaterThan(20);
    return row;
  }

  function expectAlignedHls(id: number, { audio = true } = {}) {
    const row = mockStore.get(id)!;
    const hls = row.video?.output?.hls;
    expect(hls).toBeTruthy();
    expect(hls!.master).toMatch(/^\/uploads\/video\/\d+\/v1-[0-9a-f]{8}\/master\.m3u8$/);
    const masterPath = onDisk(hls!.master);
    const master = readFileSync(masterPath, "utf8");
    const variants = master.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(variants).toHaveLength(hls!.renditions.length);
    expect(master).toMatch(/CODECS="avc1\.64[0-9a-f]{4}/);
    expect(master.includes("mp4a.40.2")).toBe(audio);

    const durations = variants.map((uri) => {
      const playlistPath = join(masterPath, "..", uri);
      const playlist = parseMediaPlaylist(readFileSync(playlistPath, "utf8"));
      expect(playlist.ended).toBe(true);
      expect(existsSync(join(playlistPath, "..", playlist.mapUri!))).toBe(true);
      for (const segment of playlist.segments) {
        expect(existsSync(join(playlistPath, "..", segment.uri))).toBe(true);
      }
      return playlist.segments.map((segment) => segment.duration.toFixed(2)).join(",");
    });
    // Every rendition cut at the same boundaries: players can switch at any segment.
    expect(new Set(durations).size).toBe(1);
    return hls!;
  }

  it("iPhone HEVC/HLG portrait: stays portrait, is tone-mapped, loses GPS/device tags, gets the full ladder", async () => {
    const outcome = await processFixture(FIXTURES.iphoneHlg, 101);
    expect(outcome).toEqual(expect.objectContaining({ status: "processed", stages: ["mp4", "hls"] }));

    const row = await expectPlayableRow(101, { width: 720, height: 1280 });
    expect(row.video?.status).toBe("streaming_ready");
    expect(row.video?.source?.probe).toEqual(
      expect.objectContaining({ videoCodec: "hevc", hdr: "hlg", displayWidth: 1080, displayHeight: 1920 }),
    );
    expect(row.video?.previous).toEqual(expect.objectContaining({ url: "/uploads/iphone_hlg_portrait.mov" }));

    // Naively squeezing HLG into 8-bit BT.709 lands around SATAVG 39 on this pattern;
    // tone-mapped output keeps most of the saturation of the SDR original (~116).
    expect(frameStats(onDisk(row.url!), 1).satavg).toBeGreaterThan(70);

    const tags = formatTags(onDisk(row.url!));
    expect(Object.keys(tags).some((key) => /location|make|model|xyz/i.test(key))).toBe(false);
    expect(tags.side).not.toContain("Display Matrix");

    const hls = expectAlignedHls(101);
    expect(hls.renditions.map((rendition) => `${rendition.width}x${rendition.height}`)).toEqual([
      "540x960",
      "360x640",
      "720x1280",
      "1080x1920",
    ]);
    // Original preserved for reprocessing and rollback.
    expect(existsSync(join(uploads, FIXTURES.iphoneHlg.file))).toBe(true);
  });

  it("is idempotent: a finished row is left alone", async () => {
    await processFixture(FIXTURES.h264, 102);
    const before = mockStore.get(102);
    const again = await processVideoFile(102, { strapi, uploadsDir: uploads, hlsEnabled: true });
    expect(again.status).toBe("up_to_date");
    expect(mockStore.get(102)).toEqual(before);
  });

  it("plain H.264 MP4 without faststart becomes a faststart 720p fallback plus a 360/540/720 ladder", async () => {
    await processFixture(FIXTURES.h264, 103);
    await expectPlayableRow(103, { width: 1280, height: 720 });
    expect(expectAlignedHls(103).renditions.map((rendition) => rendition.height).sort((a, b) => a - b)).toEqual([
      360, 540, 720,
    ]);
  });

  it("VFR screen recording comes out constant frame rate with aligned keyframes", async () => {
    await processFixture(FIXTURES.vfr, 104);
    const row = await expectPlayableRow(104, { width: 720, height: 1280 });
    expect(row.video?.source?.probe?.variableFrameRate).toBe(true);
    expectAlignedHls(104);
  });

  it("silent VP9 WebM: no audio track is invented, codecs omit AAC", async () => {
    await processFixture(FIXTURES.silentWebm, 105);
    const row = await expectPlayableRow(105, { width: 640, height: 360 }, { audio: false });
    expect(row.video?.output?.hasAudio).toBe(false);
    expectAlignedHls(105, { audio: false });
  });

  it("4K60 landscape is capped by short edge (1280x720 fallback, 1080p top) and to 30 fps", async () => {
    await processFixture(FIXTURES.landscape4k60, 106);
    const row = await expectPlayableRow(106, { width: 1280, height: 720 });
    expect(row.video?.output?.fps).toBe(30);
    expect(expectAlignedHls(106).renditions.some((rendition) => rendition.width === 1920 && rendition.height === 1080)).toBe(true);
  });

  it("odd 886x1919 screen capture encodes with even dimensions and the same aspect ratio", async () => {
    await processFixture(FIXTURES.odd, 107);
    const row = mockStore.get(107)!;
    const size = { width: row.width!, height: row.height! };
    expect(size.width % 2 + (size.height % 2)).toBe(0);
    expect(Math.abs(size.width / size.height - 886 / 1919)).toBeLessThan(0.01);
    await expectPlayableRow(107, size);
  });

  it("non-square pixels are expanded to the display aspect (1440x1080 @4:3 → 1280x720)", async () => {
    await processFixture(FIXTURES.anamorphic, 108);
    await expectPlayableRow(108, { width: 1280, height: 720 });
  });

  it("an upload truncated before its moov atom fails permanently and the row is untouched", async () => {
    await expect(processFixture(FIXTURES.truncatedMoovAtEnd, 109)).rejects.toMatchObject({ code: "probe_failed" });
    const row = mockStore.get(109)!;
    expect(row.url).toBe(`/uploads/${FIXTURES.truncatedMoovAtEnd.file}`);
    expect(row.video).toEqual(
      expect.objectContaining({
        status: "failed",
        failure: expect.objectContaining({ code: "probe_failed", stage: "probe", sourceUrl: row.url }),
      }),
    );
    // And the next trigger does not burn CPU on it again.
    await expect(processVideoFile(109, { strapi, uploadsDir: uploads, hlsEnabled: true })).resolves.toMatchObject({
      status: "up_to_date",
    });
  });

  it("a faststart upload truncated mid-data is caught by the duration check", async () => {
    await expect(processFixture(FIXTURES.truncatedFaststart, 110)).rejects.toMatchObject({ code: "decode_failed" });
    expect(mockStore.get(110)!.video?.status).toBe("failed");
    expect(mockStore.get(110)!.mime).toBe("video/mp4");
    expect(mockStore.get(110)!.url).toBe(`/uploads/${FIXTURES.truncatedFaststart.file}`);
  });

  it("does not touch a file another worker holds the lease for", async () => {
    mockStore.put(
      rowFor(FIXTURES.h264, 111, {
        video: {
          schema: 1,
          status: "processing",
          updatedAt: new Date().toISOString(),
          lease: { owner: "other-host:1:abc", jobId: "other", until: Date.now() + 60_000 },
        },
      }),
    );
    await expect(processVideoFile(111, { strapi, uploadsDir: uploads, hlsEnabled: true })).resolves.toEqual({
      status: "busy",
      fileId: 111,
    });
    expect(mockStore.get(111)!.url).toBe(`/uploads/${FIXTURES.h264.file}`);
  });

  it("ships the MP4 when HLS is disabled, then adds only HLS once enabled", async () => {
    await processFixture(FIXTURES.anamorphic, 112, { hlsEnabled: false });
    const first = mockStore.get(112)!;
    expect(first.video?.status).toBe("playback_ready");
    expect(first.video?.output?.hls).toBeNull();

    const second = await processVideoFile(112, { strapi, uploadsDir: uploads, hlsEnabled: true });
    expect(second).toEqual(expect.objectContaining({ status: "processed", stages: ["hls"] }));
    const after = mockStore.get(112)!;
    expect(after.url).toBe(first.url);
    expect(after.video?.status).toBe("streaming_ready");
    expect(after.video?.output?.hls?.token).not.toBe(after.video?.output?.token);
  });

  it("an HLS failure keeps the playable MP4; the retry publishes into a fresh directory", async () => {
    const real = mediaProcess.runMediaProcess;
    const spy = jest.spyOn(mediaProcess, "runMediaProcess").mockImplementation(async (binary, args, options) => {
      if (args.includes("hls")) {
        throw new mediaProcess.MediaProcessingError("encode_failed", "simulated ladder failure");
      }
      return real(binary, args, options);
    });
    try {
      await expect(processFixture(FIXTURES.h264, 113)).rejects.toMatchObject({ code: "encode_failed" });
    } finally {
      spy.mockRestore();
    }
    const failed = mockStore.get(113)!;
    expect(failed.mime).toBe("video/mp4");
    expect(failed.video).toEqual(
      expect.objectContaining({
        status: "playback_ready",
        failure: expect.objectContaining({ stage: "hls", code: "encode_failed" }),
      }),
    );

    const retry = await processVideoFile(113, { strapi, uploadsDir: uploads, hlsEnabled: true, attempt: 2 });
    expect(retry).toEqual(expect.objectContaining({ status: "processed", stages: ["hls"] }));
    expect(mockStore.get(113)!.video?.status).toBe("streaming_ready");
    expect(mockStore.get(113)!.video?.failure).toBeNull();
    expectAlignedHls(113);
    // No work directories left behind.
    expect(readdirSync(join(uploads, ".processing")).filter((entry) => entry.startsWith("113-"))).toEqual([]);
  });

  it("re-encodes a row repointed by the old `_web.mp4` transcoder from its original", async () => {
    // What the previous pipeline left behind: row → <hash>_web.mp4, original next to it.
    const legacyHash = "iphone_hlg_portrait";
    const { copyFileSync } = await import("node:fs");
    copyFileSync(join(uploads, FIXTURES.h264.file), join(uploads, `${legacyHash}_web.mp4`));
    mockStore.put(
      rowFor(FIXTURES.iphoneHlg, 114, {
        hash: `${legacyHash}_web`,
        ext: ".mp4",
        mime: "video/mp4",
        url: `/uploads/${legacyHash}_web.mp4`,
      }),
    );
    await processVideoFile(114, { strapi, uploadsDir: uploads, hlsEnabled: false });
    const row = mockStore.get(114)!;
    expect(row.video?.source?.url).toBe(`/uploads/${FIXTURES.iphoneHlg.file}`);
    expect(row.video?.previous?.url).toBe(`/uploads/${legacyHash}_web.mp4`);
    await expectPlayableRow(114, { width: 720, height: 1280 });
  });
  it("adds a real VP9/Opus WebM without changing the MP4 row URL", async () => {
    await processFixture(FIXTURES.h264, 200, { hlsEnabled: false });
    const original = mockStore.get(200)!;
    const outcome = await processVideoFile(200, { strapi, uploadsDir: uploads, hlsEnabled: false, webmEnabled: true, threads: 2 });
    expect(outcome).toEqual(expect.objectContaining({ stages: ["webm"] }));
    const next = mockStore.get(200)!;
    expect(next.url).toBe(original.url); expect(next.video?.pipelineVersion).toBe(1);
    const webm = next.video!.output!.webm!;
    const probe = await probeVideo(join(uploads, webm.url.split("/").pop()!));
    expect(probe).toEqual(expect.objectContaining({ videoCodec: "vp9", audioCodec: "opus", pixelFormat: "yuv420p", rotation: 0 }));
    expect(webm.bytes).toBeGreaterThan(0);
  });
  it("keeps MP4 and still publishes HLS when optional WebM encoding fails", async () => {
    await processFixture(FIXTURES.h264, 201, { hlsEnabled: false });
    const originalUrl = mockStore.get(201)!.url;
    const real = mediaProcess.runMediaProcess;
    const spy = jest.spyOn(mediaProcess, "runMediaProcess").mockImplementation(async (binary, args, options) => {
      if (args.includes("libvpx-vp9")) throw new mediaProcess.MediaProcessingError("encode_failed", "test WebM encoder failure");
      return real(binary, args, options);
    });
    try { await expect(processVideoFile(201, { strapi, uploadsDir: uploads, hlsEnabled: true, webmEnabled: true })).rejects.toMatchObject({ code: "encode_failed" }); }
    finally { spy.mockRestore(); }
    const next = mockStore.get(201)!;
    expect(next.url).toBe(originalUrl); expect(next.video?.status).toBe("streaming_ready");
    expect(next.video?.output?.hls).toBeTruthy(); expect(next.video?.failure).toBeNull();
    expect(next.video?.webmFailure).toEqual(expect.objectContaining({ stage: "webm", attempt: 1 }));
    const retried = await processVideoFile(201, { strapi, uploadsDir: uploads, hlsEnabled: true, webmEnabled: true });
    expect(retried).toEqual(expect.objectContaining({ stages: ["webm"] }));
    expect(mockStore.get(201)!.video?.webmFailure).toBeNull();
  });
  it("leaves a working MP4 available when its original is missing for WebM backfill", async () => {
    await processFixture(FIXTURES.h264, 202, { hlsEnabled: false });
    const row = mockStore.get(202)!;
    mockStore.put({ ...row, video: { ...row.video!, source: { ...row.video!.source!, url: "/uploads/missing-original.MOV" } } });
    await expect(processVideoFile(202, { strapi, uploadsDir: uploads, hlsEnabled: false, webmEnabled: true })).rejects.toMatchObject({ code: "source_missing" });
    expect(mockStore.get(202)!.url).toBe(row.url);
    expect(mockStore.get(202)!.video?.status).toBe("playback_ready");
    expect(mockStore.get(202)!.video?.webmFailure?.code).toBe("source_missing");
  });
  it("cannot publish optional WebM after losing its lease", async () => {
    await processFixture(FIXTURES.h264, 203, { hlsEnabled: false });
    const originalUrl = mockStore.get(203)!.url;
    const realWrite = mockStore.writeVideoState;
    const spy = jest.spyOn(mockStore, "writeVideoState").mockImplementation(async (db, id, owner, patch, update) => {
      if (patch.output?.webm) {
        const row = mockStore.get(id)!;
        mockStore.put({ ...row, video: { ...row.video!, lease: { owner: "new-holder", jobId: "other", until: Date.now() + 60_000 } } });
      }
      return realWrite(db, id, owner, patch, update);
    });
    try {
      await expect(processVideoFile(203, { strapi, uploadsDir: uploads, hlsEnabled: false, webmEnabled: true })).rejects.toMatchObject({ code: "terminated" });
      const row = mockStore.get(203)!;
      expect(row.url).toBe(originalUrl);
      expect(row.video?.output?.webm).toBeUndefined();
      expect(row.video?.lease?.owner).toBe("new-holder");
      expect(row.video?.webmFailure).toBeFalsy();
    } finally { spy.mockRestore(); }
  });

});

// Opt-in exact-byte regression; the public copy is deliberately never committed.
const public113033Fixture = process.env.MEDIA_VIDEO_113033_FIXTURE_PATH;
const describeWithPublic113033 = public113033Fixture && ffmpegAvailable() ? describe : describe.skip;

describeWithPublic113033("public file 113033 normalization (real ffmpeg)", () => {
  const sourceSha256 = "cb3fd1b35685c508f59efa433aba5215c5b9ea8e9206eee5201d8d31bd2cabdb";
  const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const strapi = {
    db: { connection: { raw: jest.fn(async () => ({ rows: [] })) }, query: jest.fn() },
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  let uploads: string;

  beforeAll(() => {
    uploads = mkdtempSync(join(tmpdir(), "media-113033-proof-"));
  });

  afterAll(() => {
    if (uploads) rmSync(uploads, { recursive: true, force: true });
  });

  it("normalizes the exact HEVC MOV to faststart H264/AAC MP4 with poster and rollback snapshot", async () => {
    expect(sha256(public113033Fixture!)).toBe(sourceSha256);
    const originalPath = join(uploads, "media_113033.mov");
    copyFileSync(public113033Fixture!, originalPath);
    const original: FileRow = {
      id: 113033, name: "media_113033.mov", hash: "media_113033", ext: ".mov",
      mime: "video/quicktime", size: statSync(originalPath).size / 1024,
      url: "/uploads/media_113033.mov", previewUrl: null, width: 720, height: 1280, video: null,
    };
    mockStore = createMemoryVideoStore([original]);
    const lease = jest.spyOn(mockStore, "claimLease");
    const deps = { strapi, uploadsDir: uploads, hlsEnabled: false, webmEnabled: false, threads: 2, jobId: "local-proof-113033" };
    const diskPath = (url: string) => join(uploads, url.replace(/^\/uploads\//, ""));
    try {
      const dryRun = await processVideoFile(113033, { ...deps, dryRun: true });
      expect(dryRun).toMatchObject({ status: "would_process", probe: {
        videoCodec: "hevc", audioCodec: "aac", displayWidth: 720, displayHeight: 1280, durationMs: 15_700,
      } });
      expect(mockStore.get(113033)).toEqual(original);
      expect(readdirSync(uploads)).toEqual(["media_113033.mov"]);
      expect(lease).not.toHaveBeenCalled();

      expect(await processVideoFile(113033, deps)).toMatchObject({ status: "processed", stages: ["mp4"] });
      expect(lease).toHaveBeenCalledTimes(1);
      const row = mockStore.get(113033)!;
      const output = await probeVideo(diskPath(row.url!));
      expect(row).toMatchObject({ ext: ".mp4", mime: "video/mp4", width: 720, height: 1280 });
      expect(output).toMatchObject({
        videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", fastStart: true,
        displayWidth: 720, displayHeight: 1280, hasAudio: true, rotation: 0,
      });
      expect(Math.abs(output.durationMs! - 15_700)).toBeLessThan(100);
      expect(row.video).toMatchObject({
        status: "playback_ready", failure: null, lease: null,
        source: { url: original.url, probe: { videoCodec: "hevc", audioCodec: "aac" } },
        previous: snapshotRow(original),
      });
      expect(row.video!.previous).toEqual(snapshotRow(original));
      expect(row.url).toBe(row.video!.output!.mp4.url);
      expect(row.url).toBe(`/uploads/${row.hash}${row.ext}`);
      expect(row.previewUrl).toBe(row.video!.output!.poster!.url);
      const posterPath = diskPath(row.previewUrl!);
      expect(statSync(posterPath).size).toBeGreaterThan(1000);
      expect(readFileSync(posterPath).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(sha256(originalPath)).toBe(sourceSha256);
      expect(sha256(public113033Fixture!)).toBe(sourceSha256);
      expect(await processVideoFile(113033, deps)).toMatchObject({ status: "up_to_date" });
      expect(lease).toHaveBeenCalledTimes(1);
      console.info("media-113033-local-proof", JSON.stringify({
        sourceSha256, sourceBytes: statSync(originalPath).size,
        videoCodec: output.videoCodec, audioCodec: output.audioCodec, pixelFormat: output.pixelFormat,
        width: output.displayWidth, height: output.displayHeight, durationMs: output.durationMs,
        fastStart: output.fastStart, mp4Bytes: statSync(diskPath(row.url!)).size,
        posterBytes: statSync(posterPath).size, originalPreserved: true, rollbackSnapshotPreserved: true,
        leaseReleased: row.video!.lease === null,
      }));
    } finally {
      lease.mockRestore();
    }
  }, 120_000);
});
