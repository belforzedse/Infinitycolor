const mockProbeVideo = jest.fn();

jest.mock("node:fs/promises", () => ({
  stat: jest.fn(async () => ({ size: 100 })),
  rename: jest.fn(),
  unlink: jest.fn(async () => undefined),
}));

jest.mock("../video-normalization", () => ({
  probeVideo: (...args: unknown[]) => mockProbeVideo(...args),
  decideNormalization: jest.fn(() => ({ needed: false, reasons: [] })),
  transcodeToWebSafeMp4: jest.fn(),
}));

import { normalizeUploadFile } from "../normalize-upload-video";

describe("shared upload normalization", () => {
  it("collapses concurrent jobs for the same upload file", async () => {
    let release!: (value: unknown) => void;
    mockProbeVideo.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const file = { id: 44, url: "/uploads/shared.mov", mime: "video/quicktime" };
    const deps = { strapi: { entityService: { update: jest.fn() } }, uploadsDir: "/uploads" } as any;
    const first = normalizeUploadFile(file, deps);
    const second = normalizeUploadFile(file, deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockProbeVideo).toHaveBeenCalledTimes(1);
    release({ durationMs: 3000 });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ fileId: 44, status: "skipped", durationMs: 3000 }),
      expect.objectContaining({ fileId: 44, status: "skipped", durationMs: 3000 }),
    ]);
    expect(mockProbeVideo).toHaveBeenCalledTimes(1);
  });
});
