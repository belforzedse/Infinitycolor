const mockNormalizeUploadFile = jest.fn();
const mockLoadUploadVideoFile = jest.fn();

jest.mock("../normalize-upload-video", () => {
  const actual = jest.requireActual("../normalize-upload-video") as typeof import("../normalize-upload-video");
  return {
    ...actual,
    normalizeUploadFile: (...args: unknown[]) => mockNormalizeUploadFile(...args),
    loadUploadVideoFile: (...args: unknown[]) => mockLoadUploadVideoFile(...args),
  };
});

import {
  findProductsNeedingVideoNormalization,
  normalizeProductVideoFile,
  normalizeProductVideos,
} from "../normalize-product-video";

const MOV = {
  id: 120001,
  mime: "video/quicktime",
  ext: ".MOV",
  url: "/uploads/IMG_8997_e5aba22d0e.MOV",
};

function strapiWithProduct(product: unknown) {
  return {
    entityService: {
      findOne: jest.fn().mockResolvedValue(product),
      findMany: jest.fn(),
    },
  };
}

describe("normalizeProductVideoFile", () => {
  beforeEach(() => {
    mockNormalizeUploadFile.mockReset();
    mockLoadUploadVideoFile.mockReset();
  });

  it("returns missing when the product is gone", async () => {
    const result = await normalizeProductVideoFile(9, 120001, {
      strapi: strapiWithProduct(null),
      uploadsDir: "/uploads",
    });
    expect(result).toEqual({ productId: 9, status: "missing", files: [], detail: "product not found" });
    expect(mockNormalizeUploadFile).not.toHaveBeenCalled();
  });

  it("refuses to transcode a file that is not attached to the product", async () => {
    const result = await normalizeProductVideoFile(4624, 99, {
      strapi: strapiWithProduct({
        id: 4624,
        Slug: "fantasy-sleeping-set-n002",
        Media: [MOV],
      }),
      uploadsDir: "/uploads",
    });
    expect(result.status).toBe("missing");
    expect(result.detail).toMatch(/not attached/);
    expect(mockNormalizeUploadFile).not.toHaveBeenCalled();
  });

  it("normalizes the attached QuickTime clip", async () => {
    mockNormalizeUploadFile.mockResolvedValue({
      fileId: 120001,
      status: "normalized",
    });
    const result = await normalizeProductVideoFile(4624, 120001, {
      strapi: strapiWithProduct({
        id: 4624,
        Slug: "fantasy-sleeping-set-n002",
        CoverImage: { id: 1, mime: "image/webp", url: "/uploads/cover.webp" },
        Media: [MOV],
      }),
      uploadsDir: "/uploads",
    });
    expect(result).toMatchObject({
      productId: 4624,
      slug: "fantasy-sleeping-set-n002",
      status: "normalized",
    });
    expect(mockNormalizeUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 120001, mime: "video/quicktime" }),
      expect.objectContaining({ nameHint: "product-4624-120001" }),
    );
  });
});

describe("normalizeProductVideos", () => {
  beforeEach(() => mockNormalizeUploadFile.mockReset());

  it("returns missing when the product has no video media", async () => {
    const result = await normalizeProductVideos(1, {
      strapi: strapiWithProduct({
        id: 1,
        Slug: "no-video",
        Media: [{ id: 2, mime: "image/webp", url: "/uploads/still.webp" }],
      }),
      uploadsDir: "/uploads",
    });
    expect(result).toMatchObject({ productId: 1, status: "missing", detail: "no video media" });
  });
});

describe("findProductsNeedingVideoNormalization", () => {
  it("lists products whose gallery still has a QuickTime clip", async () => {
    const strapi = {
      entityService: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 4624,
              CoverImage: { id: 1, mime: "image/webp" },
              Media: [MOV],
            },
            {
              id: 10,
              Media: [{ id: 3, mime: "video/mp4", ext: ".mp4", url: "/uploads/clip_web.mp4" }],
            },
          ])
          .mockResolvedValueOnce([]),
      },
    };

    await expect(findProductsNeedingVideoNormalization(strapi)).resolves.toEqual([4624]);
  });
});
