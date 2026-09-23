const mockProcessVideoFile = jest.fn();

jest.mock("../video-pipeline", () => ({
  processVideoFile: (...args: unknown[]) => mockProcessVideoFile(...args),
}));

import { MediaBusyError, normalizeUploadFile } from "../normalize-upload-video";

describe("shared upload normalization", () => {
  beforeEach(() => mockProcessVideoFile.mockReset());

  it("collapses concurrent jobs for the same upload file within a process", async () => {
    let release!: (value: unknown) => void;
    mockProcessVideoFile.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const file = { id: 44, url: "/uploads/shared.mov", mime: "video/quicktime" };
    const deps = { strapi: {}, uploadsDir: "/uploads" } as any;
    const first = normalizeUploadFile(file, deps);
    const second = normalizeUploadFile(file, deps);
    await Promise.resolve();
    expect(mockProcessVideoFile).toHaveBeenCalledTimes(1);
    release({
      status: "up_to_date",
      fileId: 44,
      video: { schema: 1, status: "playback_ready", updatedAt: "", output: { durationMs: 3000 } },
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ fileId: 44, status: "skipped", durationMs: 3000 }),
      expect.objectContaining({ fileId: 44, status: "skipped", durationMs: 3000 }),
    ]);
  });

  it("reports freshly produced assets as normalized so callers refresh caches and durations", async () => {
    mockProcessVideoFile.mockResolvedValueOnce({
      status: "processed",
      fileId: 7,
      stages: ["mp4"],
      video: { schema: 1, status: "playback_ready", updatedAt: "", output: { durationMs: 4200 } },
    });
    await expect(normalizeUploadFile({ id: 7 }, { strapi: {}, uploadsDir: "/u" } as any)).resolves.toEqual(
      expect.objectContaining({ status: "normalized", durationMs: 4200, reasons: ["produced mp4"] }),
    );
  });

  it("surfaces another worker's lease as MediaBusyError for the job to delay", async () => {
    mockProcessVideoFile.mockResolvedValueOnce({ status: "busy", fileId: 8 });
    await expect(normalizeUploadFile({ id: 8 }, { strapi: {}, uploadsDir: "/u" } as any)).rejects.toBeInstanceOf(
      MediaBusyError,
    );
  });
});
