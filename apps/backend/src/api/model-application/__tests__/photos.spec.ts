import { detectImageKind, validateIncomingPhoto } from "../lib/photos";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("model application photo validation", () => {
  it("detects jpeg, png, and webp magic bytes", () => {
    expect(detectImageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(detectImageKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "png",
    );
    expect(detectImageKind(Buffer.from("RIFF....WEBP", "ascii"))).toBe("webp");
    expect(detectImageKind(Buffer.from("GIF89a"))).toBeNull();
  });

  it("rejects a mismatched mime type even when the size is legal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-app-"));
    const filepath = join(dir, "photo.bin");
    await writeFile(filepath, Buffer.from("not-an-image"));
    await expect(
      validateIncomingPhoto(
        {
          filepath,
          originalFilename: "photo.bin",
          mimetype: "image/jpeg",
          size: 12,
        },
        "photoTwo",
      ),
    ).rejects.toMatchObject({
      code: "MODEL_APPLICATION_PHOTO_TYPE",
      status: 415,
    });
    await rm(dir, { recursive: true, force: true });
  });
});
