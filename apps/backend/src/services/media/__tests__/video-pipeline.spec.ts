jest.mock("@sentry/node", () => ({ captureMessage: jest.fn() }));

import type { FileRow, VideoMetadata } from "../video-metadata";
import { assessVideoRow } from "../video-pipeline";
import { derivedBaseName, derivedFileNames, hlsMasterUrl, processingDir, uploadFilePath } from "../video-paths";

function row(video: Partial<VideoMetadata> | null, overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: 5,
    name: "IMG_1.MOV",
    hash: "IMG_1_abc",
    ext: ".MOV",
    mime: "video/quicktime",
    size: 1000,
    url: "/uploads/IMG_1_abc.MOV",
    previewUrl: null,
    width: null,
    height: null,
    video: video ? ({ schema: 1, status: "queued", updatedAt: "", ...video } as VideoMetadata) : null,
    ...overrides,
  };
}

const owned = (extra: Partial<VideoMetadata> = {}): FileRow =>
  row(
    {
      status: "playback_ready",
      pipelineVersion: 1,
      output: {
        token: "v1-00000001",
        width: 720,
        height: 1280,
        fps: 30,
        durationMs: 3000,
        hasAudio: true,
        mp4: { url: "/uploads/IMG_1_abc_v1-00000001.mp4", bytes: 1 },
        poster: null,
        hls: null,
      },
      ...extra,
    },
    { url: "/uploads/IMG_1_abc_v1-00000001.mp4", mime: "video/mp4", ext: ".mp4" },
  );

describe("assessVideoRow", () => {
  it("processes a fresh upload and a legacy row with no metadata", () => {
    expect(assessVideoRow(row({ status: "queued" }), { hlsEnabled: false })).toEqual(
      expect.objectContaining({ mp4: true, hls: false }),
    );
    expect(assessVideoRow(row(null), { hlsEnabled: true })).toEqual(
      expect.objectContaining({ mp4: true, hls: true, reasons: ["not processed yet"] }),
    );
  });

  it("leaves a finished row alone, and only adds HLS once it is enabled", () => {
    expect(assessVideoRow(owned(), { hlsEnabled: false })).toEqual(expect.objectContaining({ mp4: false, hls: false }));
    expect(assessVideoRow(owned(), { hlsEnabled: true })).toEqual(expect.objectContaining({ mp4: false, hls: true }));
  });

  it("reprocesses when an admin replaced the file behind a processed row", () => {
    const replaced = { ...owned(), url: "/uploads/new_upload.mov", mime: "video/quicktime" };
    expect(assessVideoRow(replaced, { hlsEnabled: false })).toEqual(
      expect.objectContaining({ mp4: true, reasons: ["row points at a different file than the pipeline output"] }),
    );
  });

  it("does not retry a permanent failure on the same file, but does once the file changes or when forced", () => {
    const failed = row({
      status: "failed",
      failure: { stage: "probe", code: "decode_failed", message: "", attempt: 1, at: "", sourceUrl: "/uploads/IMG_1_abc.MOV" },
    });
    expect(assessVideoRow(failed, { hlsEnabled: true }).mp4).toBe(false);
    expect(assessVideoRow(failed, { hlsEnabled: true, force: true }).mp4).toBe(true);
    expect(assessVideoRow({ ...failed, url: "/uploads/other.mov" }, { hlsEnabled: true }).mp4).toBe(true);
  });

  it("retries a transient failure", () => {
    const failed = row({
      status: "failed",
      failure: { stage: "mp4", code: "killed_oom", message: "", attempt: 1, at: "", sourceUrl: "/uploads/IMG_1_abc.MOV" },
    });
    expect(assessVideoRow(failed, { hlsEnabled: false }).mp4).toBe(true);
  });

  it("respects an operator rollback until the file changes", () => {
    const rolledBack = row(
      { status: "rolled_back", previous: { url: "/uploads/IMG_1_abc.MOV" } as any },
      { url: "/uploads/IMG_1_abc.MOV" },
    );
    expect(assessVideoRow(rolledBack, { hlsEnabled: true }).mp4).toBe(false);
    expect(assessVideoRow({ ...rolledBack, url: "/uploads/replacement.mov" }, { hlsEnabled: true }).mp4).toBe(true);
  });

  it("re-encodes rows from an older pipeline version", () => {
    expect(assessVideoRow(owned({ pipelineVersion: 0 }), { hlsEnabled: false }).mp4).toBe(true);
  });
});

describe("derived paths", () => {
  it("derives stems from the original hash without stacking earlier suffixes", () => {
    expect(derivedBaseName("IMG_8997_e5aba22d0e", 1)).toBe("IMG_8997_e5aba22d0e");
    expect(derivedBaseName("IMG_8997_e5aba22d0e_web", 1)).toBe("IMG_8997_e5aba22d0e");
    expect(derivedBaseName("clip_v1-0a1b2c3d", 1)).toBe("clip");
    expect(derivedBaseName("../../etc/passwd", 1)).toBe(".._.._etc_passwd");
    expect(derivedBaseName(null, 42)).toBe("file-42");
  });

  it("only builds paths from a numeric id and a well-formed token", () => {
    expect(derivedFileNames("clip", "v1-0a1b2c3d")).toEqual({
      hash: "clip_v1-0a1b2c3d",
      mp4: "clip_v1-0a1b2c3d.mp4",
      poster: "clip_v1-0a1b2c3d.jpg",
    });
    expect(hlsMasterUrl(7, "v1-0a1b2c3d")).toBe("/uploads/video/7/v1-0a1b2c3d/master.m3u8");
    expect(() => processingDir("/u", 7, "../x")).toThrow(/invalid asset token/);
    expect(() => processingDir("/u", -1, "v1-0a1b2c3d")).toThrow(/invalid file id/);
    expect(() => uploadFilePath("/u", "/uploads/../../secret")).toThrow(/unexpected upload url/);
  });
});
