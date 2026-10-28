const mockNormalizeUploadFile = jest.fn();

jest.mock("../normalize-upload-video", () => ({
  normalizeUploadFile: (...args: unknown[]) => mockNormalizeUploadFile(...args),
  collectVideoUploads: jest.fn(),
  isVideoUpload: jest.fn(),
  looksLikeUnsafeWebVideo: jest.fn(() => true),
}));

import {
  findStoryVideosNeedingNormalization,
  normalizeStoryVideo,
} from "../normalize-story-video";

const target = { id: 2, url: "/uploads/source.mov", mime: "video/quicktime" };

function deps(findOne: jest.Mock) {
  return {
    strapi: {
      entityService: {
        findOne,
        findMany: jest.fn(),
        update: jest.fn(),
      },
    },
    uploadsDir: "/uploads",
  } as any;
}

describe("per-item story video normalization", () => {
  beforeEach(() => mockNormalizeUploadFile.mockReset());

  it("updates only the matching item duration and preserves canonical order", async () => {
    const initial = { id: 9, Items: [
      { id: 10, Key: "a", MediaType: "video", Media: target, DurationMs: 1000 },
      { id: 11, Key: "b", MediaType: "image", Media: { id: 3, url: "/b.webp" }, DurationMs: 5000 },
    ] };
    const findOne = jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(initial);
    const testDeps = deps(findOne);
    mockNormalizeUploadFile.mockResolvedValue({ fileId: 2, status: "normalized", durationMs: 4200 });
    await normalizeStoryVideo(9, "a", 2, testDeps);
    expect(testDeps.strapi.entityService.update).toHaveBeenCalledWith("api::story.story", 9, {
      data: { Items: [
        expect.objectContaining({ id: 10, Key: "a", DurationMs: 4200 }),
        initial.Items[1],
      ] },
    });
  });

  it("does not write a duration after the item media reference changes", async () => {
    const initial = { id: 9, Items: [{ Key: "a", MediaType: "video", Media: target, DurationMs: 1000 }] };
    const latest = { id: 9, Items: [{ Key: "a", MediaType: "video", Media: { ...target, id: 8 }, DurationMs: 1000 }] };
    const findOne = jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(latest);
    const testDeps = deps(findOne);
    mockNormalizeUploadFile.mockResolvedValue({ fileId: 2, status: "normalized", durationMs: 4200 });
    await normalizeStoryVideo(9, "a", 2, testDeps);
    expect(testDeps.strapi.entityService.update).not.toHaveBeenCalled();
  });

  it("rejects a stale queued file before normalization", async () => {
    const findOne = jest.fn().mockResolvedValue({ id: 9, Items: [{ Key: "a", MediaType: "video", Media: { ...target, id: 8 } }] });
    const result = await normalizeStoryVideo(9, "a", 2, deps(findOne));
    expect(result).toEqual(expect.objectContaining({ status: "missing", detail: "item media changed" }));
    expect(mockNormalizeUploadFile).not.toHaveBeenCalled();
  });

  it("discovers every item target, including shared upload references", async () => {
    const strapi = { entityService: { findMany: jest.fn().mockResolvedValue([
      { id: 9, Items: [
        { Key: "a", MediaType: "video", Media: target },
        { Key: "b", MediaType: "video", Media: target },
      ] },
    ]) } };
    await expect(findStoryVideosNeedingNormalization(strapi)).resolves.toEqual([
      { storyId: 9, itemKey: "a", fileId: 2 },
      { storyId: 9, itemKey: "b", fileId: 2 },
    ]);
  });
});
