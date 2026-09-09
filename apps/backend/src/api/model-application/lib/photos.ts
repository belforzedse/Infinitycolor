import { open } from "node:fs/promises";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const ALLOWED_PHOTO_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export type DetectedImageKind = "jpeg" | "png" | "webp";

export type IncomingUploadFile = {
  filepath: string;
  originalFilename: string;
  mimetype: string;
  size: number;
};

export class ModelApplicationPhotoError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ModelApplicationPhotoError";
  }
}

export function detectImageKind(header: Buffer): DetectedImageKind | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "jpeg";
  }
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47
  ) {
    return "png";
  }
  if (
    header.length >= 12 &&
    header.toString("ascii", 0, 4) === "RIFF" &&
    header.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

function mimeMatchesKind(mimetype: string, kind: DetectedImageKind): boolean {
  if (kind === "jpeg") return mimetype === "image/jpeg" || mimetype === "image/jpg";
  if (kind === "png") return mimetype === "image/png";
  return mimetype === "image/webp";
}

export async function validateIncomingPhoto(
  file: IncomingUploadFile,
  field: "photoOne" | "photoTwo",
): Promise<IncomingUploadFile> {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new ModelApplicationPhotoError(
      "MODEL_APPLICATION_PHOTO_INVALID",
      400,
      "فایل تصویر معتبر نیست. دوباره تلاش کنید.",
      { field },
    );
  }
  if (file.size > MAX_PHOTO_BYTES) {
    throw new ModelApplicationPhotoError(
      "MODEL_APPLICATION_PHOTO_TOO_LARGE",
      413,
      "حجم هر عکس باید حداکثر ۵ مگابایت باشد.",
      { field, maxBytes: MAX_PHOTO_BYTES },
    );
  }
  const mime = file.mimetype.trim().toLowerCase();
  if (!ALLOWED_PHOTO_MIME.has(mime)) {
    throw new ModelApplicationPhotoError(
      "MODEL_APPLICATION_PHOTO_TYPE",
      415,
      "فقط تصویر JPEG، PNG یا WebP پذیرفته می‌شود.",
      { field },
    );
  }
  let header: Buffer;
  try {
    const handle = await open(file.filepath, "r");
    try {
      header = Buffer.alloc(16);
      await handle.read(header, 0, 16, 0);
    } finally {
      await handle.close();
    }
  } catch {
    throw new ModelApplicationPhotoError(
      "MODEL_APPLICATION_PHOTO_UNREADABLE",
      400,
      "خواندن تصویر انجام نشد. دوباره تلاش کنید.",
      { field },
    );
  }
  const kind = detectImageKind(header);
  if (!kind || !mimeMatchesKind(mime, kind)) {
    throw new ModelApplicationPhotoError(
      "MODEL_APPLICATION_PHOTO_TYPE",
      415,
      "فقط تصویر JPEG، PNG یا WebP پذیرفته می‌شود.",
      { field },
    );
  }
  return file;
}

export function extractUploadFile(value: unknown): IncomingUploadFile | null {
  if (Array.isArray(value)) return extractUploadFile(value[0]);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const filepath =
    typeof record.filepath === "string"
      ? record.filepath
      : typeof record.path === "string"
        ? record.path
        : null;
  const size = Number(record.size);
  if (!filepath || !Number.isFinite(size)) return null;
  const originalFilename =
    typeof record.originalFilename === "string" && record.originalFilename.trim()
      ? record.originalFilename.trim()
      : typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : "photo";
  const mimetype =
    typeof record.mimetype === "string"
      ? record.mimetype
      : typeof record.type === "string"
        ? record.type
        : "";
  return { filepath, originalFilename, mimetype, size };
}

export function toUploadDescriptor(file: IncomingUploadFile) {
  return {
    filepath: file.filepath,
    path: file.filepath,
    originalFilename: file.originalFilename,
    name: file.originalFilename,
    mimetype: file.mimetype,
    type: file.mimetype,
    size: file.size,
  };
}
