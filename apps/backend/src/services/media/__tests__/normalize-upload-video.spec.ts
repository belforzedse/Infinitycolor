import {
  asUploadVideoFile,
  collectVideoUploads,
  looksLikeUnsafeWebVideo,
  uploadFilePath,
} from "../normalize-upload-video";

describe("collectVideoUploads", () => {
  it("picks CoverImage and Media videos, including the production iPhone MOV shape", () => {
    const files = collectVideoUploads({
      CoverImage: {
        id: 1,
        mime: "image/webp",
        url: "/uploads/cover.webp",
      },
      Media: [
        {
          id: 110713,
          mime: "image/webp",
          url: "/uploads/still.webp",
        },
        {
          id: 120001,
          name: "IMG_8997.MOV",
          mime: "video/quicktime",
          ext: ".MOV",
          url: "/uploads/IMG_8997_e5aba22d0e.MOV",
          hash: "IMG_8997_e5aba22d0e",
        },
        {
          id: 120001,
          mime: "video/quicktime",
          url: "/uploads/IMG_8997_e5aba22d0e.MOV",
        },
      ],
    });

    expect(files).toEqual([
      expect.objectContaining({
        id: 120001,
        mime: "video/quicktime",
        url: "/uploads/IMG_8997_e5aba22d0e.MOV",
      }),
    ]);
  });

  it("unwraps Strapi data/attributes wrappers", () => {
    const files = collectVideoUploads({
      Media: {
        data: {
          id: 9,
          attributes: { mime: "video/mp4", url: "/uploads/clip.mp4" },
        },
      },
    });
    expect(files).toEqual([expect.objectContaining({ id: 9, mime: "video/mp4" })]);
  });
});

describe("looksLikeUnsafeWebVideo", () => {
  it("flags the live teddy-set clip (HEVC QuickTime, moov at end)", () => {
    expect(
      looksLikeUnsafeWebVideo({
        mime: "video/quicktime",
        ext: ".MOV",
        url: "/uploads/IMG_8997_e5aba22d0e.MOV",
      }),
    ).toBe(true);
  });

  it("leaves a progressive mp4 for the job to probe rather than listing it as unsafe", () => {
    expect(
      looksLikeUnsafeWebVideo({
        mime: "video/mp4",
        ext: ".mp4",
        url: "/uploads/clip_web.mp4",
      }),
    ).toBe(false);
  });

  it("flags a .MOV even if the row was stored as video/mp4", () => {
    expect(
      looksLikeUnsafeWebVideo({
        mime: "video/mp4",
        ext: ".MOV",
        url: "/uploads/IMG_8997_e5aba22d0e.MOV",
      }),
    ).toBe(true);
  });
});

describe("asUploadVideoFile / uploadFilePath", () => {
  it("rejects path traversal in upload urls", () => {
    expect(() => uploadFilePath("/uploads", "/uploads/../secret.mov")).toThrow(
      /unexpected upload url/,
    );
  });

  it("returns null for a relation without an id", () => {
    expect(asUploadVideoFile({ mime: "video/mp4", url: "/uploads/x.mp4" })).toBeNull();
  });
});
