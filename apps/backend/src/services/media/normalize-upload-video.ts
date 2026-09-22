import { rename, stat, unlink } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import {
  decideNormalization,
  probeVideo,
  transcodeToWebSafeMp4,
  type NormalizationDecision,
  type VideoProbe,
} from "./video-normalization";

/**
 * Web-safe transcode of a single `plugin::upload.file` row.
 *
 * Shared by story and product gallery jobs: phone recordings and the WooCommerce
 * import land as HEVC QuickTime (`.mov` / `video/quicktime`) which Chromium
 * parses, "plays", and then paints zero frames with no `error` event.
 */

export interface UploadVideoFile {
  id: number;
  name?: string | null;
  url?: string | null;
  mime?: string | null;
  ext?: string | null;
  hash?: string | null;
  size?: number | null;
}

export interface NormalizeFileResult {
  fileId: number | null;
  status: "skipped" | "normalized" | "would-normalize" | "missing";
  decision?: NormalizationDecision;
  probe?: VideoProbe;
  fromBytes?: number;
  toBytes?: number;
  durationMs?: number | null;
  detail?: string;
}

export interface NormalizeFileDeps {
  strapi: any;
  /** Absolute path of the directory Strapi serves `/uploads/*` from. */
  uploadsDir: string;
  dryRun?: boolean;
  /** Used in the output filename when the upload row has no hash. */
  nameHint?: string;
}

export function isVideoUpload(file: { mime?: string | null } | null | undefined): boolean {
  return Boolean(file?.mime && String(file.mime).toLowerCase().startsWith("video/"));
}

/**
 * Cheap listing filter. HEVC can also live inside `video/mp4`, so a queued job
 * still re-probes; this only keeps image-only products and already-web files
 * off the backfill candidate list.
 */
export function looksLikeUnsafeWebVideo(file: {
  mime?: string | null;
  ext?: string | null;
  url?: string | null;
}): boolean {
  if (!isVideoUpload(file)) return false;
  const mime = String(file.mime ?? "").toLowerCase();
  const ext = String(file.ext ?? "").toLowerCase();
  const url = String(file.url ?? "").toLowerCase();
  if (ext === ".mov" || url.endsWith(".mov") || mime.includes("quicktime")) return true;
  return mime !== "video/mp4" && mime !== "video/webm";
}

export function asUploadVideoFile(value: unknown): UploadVideoFile | null {
  if (!value || typeof value !== "object") return null;
  const node = value as {
    id?: number;
    data?: { id?: number; attributes?: Record<string, unknown> };
    attributes?: Record<string, unknown>;
  };
  const inner = node.data && typeof node.data === "object" ? node.data : node;
  const attrs =
    inner.attributes && typeof inner.attributes === "object" ? inner.attributes : inner;
  const id = Number(inner.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    name: (attrs as UploadVideoFile).name ?? null,
    url: (attrs as UploadVideoFile).url ?? null,
    mime: (attrs as UploadVideoFile).mime ?? null,
    ext: (attrs as UploadVideoFile).ext ?? null,
    hash: (attrs as UploadVideoFile).hash ?? null,
    size: (attrs as UploadVideoFile).size ?? null,
  };
}

export function collectVideoUploads(source: {
  CoverImage?: unknown;
  Media?: unknown;
}): UploadVideoFile[] {
  const candidates: unknown[] = [];
  if (source.CoverImage) candidates.push(source.CoverImage);
  if (Array.isArray(source.Media)) candidates.push(...source.Media);
  else if (source.Media) candidates.push(source.Media);

  const seen = new Set<number>();
  const files: UploadVideoFile[] = [];
  for (const candidate of candidates) {
    const file = asUploadVideoFile(candidate);
    if (!file || !isVideoUpload(file) || seen.has(file.id)) continue;
    seen.add(file.id);
    files.push(file);
  }
  return files;
}

export function uploadFilePath(uploadsDir: string, url: string): string {
  // Local provider URLs are always `/uploads/<name>`; guard against anything else so we
  // never write outside the uploads volume.
  const name = url.replace(/^.*\/uploads\//, "");
  if (!name || name.includes("..") || name.includes("/")) {
    throw new Error(`unexpected upload url: ${url}`);
  }
  return join(uploadsDir, name);
}

export async function loadUploadVideoFile(
  strapi: any,
  fileId: number,
): Promise<UploadVideoFile | null> {
  const file = await strapi.entityService.findOne("plugin::upload.file", fileId, {
    fields: ["id", "name", "url", "mime", "ext", "hash", "size"],
  });
  return asUploadVideoFile(file);
}

const uploadNormalizationInFlight = new Map<number, Promise<NormalizeFileResult>>();

async function normalizeUploadFileOnce(
  file: UploadVideoFile,
  { strapi, uploadsDir, dryRun = false, nameHint }: NormalizeFileDeps,
): Promise<NormalizeFileResult> {
  if (!file.url) {
    return { fileId: file.id, status: "missing", detail: "upload row has no url" };
  }

  const sourcePath = uploadFilePath(uploadsDir, file.url);

  try {
    await stat(sourcePath);
  } catch {
    return { fileId: file.id, status: "missing", detail: `not on disk: ${sourcePath}` };
  }

  const probe = await probeVideo(sourcePath);
  const decision = decideNormalization(probe, {
    mime: file.mime,
    extension: extname(sourcePath),
  });

  if (!decision.needed) {
    return {
      fileId: file.id,
      status: "skipped",
      decision,
      probe,
      durationMs: probe.durationMs,
    };
  }

  if (dryRun) {
    return {
      fileId: file.id,
      status: "would-normalize",
      decision,
      probe,
      fromBytes: (await stat(sourcePath)).size,
      durationMs: probe.durationMs,
    };
  }

  const baseName = (file.hash || nameHint || `file-${file.id}`).replace(/[^\w.-]/g, "_");
  const outputName = `${baseName}_web.mp4`;
  const outputPath = join(dirname(sourcePath), outputName);
  const tempPath = `${outputPath}.partial`;

  try {
    await transcodeToWebSafeMp4(sourcePath, tempPath);
    // Publish atomically: a half-written file must never become reachable at the URL we
    // are about to point the row at.
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  const [fromBytes, toBytes, outputProbe] = await Promise.all([
    stat(sourcePath).then((entry) => entry.size),
    stat(outputPath).then((entry) => entry.size),
    probeVideo(outputPath),
  ]);

  await strapi.entityService.update("plugin::upload.file", file.id, {
    data: {
      name: outputName,
      url: `/uploads/${outputName}`,
      ext: ".mp4",
      mime: "video/mp4",
      hash: `${baseName}_web`,
      size: Number((toBytes / 1024).toFixed(2)),
      width: outputProbe.width ?? undefined,
      height: outputProbe.height ?? undefined,
    },
  });

  return {
    fileId: file.id,
    status: "normalized",
    decision,
    probe,
    fromBytes,
    toBytes,
    durationMs: outputProbe.durationMs,
  };
}

/** Collapse story/product/upload jobs that point at the same shared upload. */
export async function normalizeUploadFile(
  file: UploadVideoFile,
  deps: NormalizeFileDeps,
): Promise<NormalizeFileResult> {
  const running = uploadNormalizationInFlight.get(file.id);
  if (running) return running;
  const task = normalizeUploadFileOnce(file, deps);
  uploadNormalizationInFlight.set(file.id, task);
  try {
    return await task;
  } finally {
    if (uploadNormalizationInFlight.get(file.id) === task) {
      uploadNormalizationInFlight.delete(file.id);
    }
  }
}
