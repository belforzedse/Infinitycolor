import type { VideoMetadata } from "./video-metadata";
import type { VideoProbe } from "./video-normalization";
import { processVideoFile, type PipelineDeps } from "./video-pipeline";
export { uploadFilePath } from "./video-paths";

/**
 * Entry point shared by the story, product and upload-time jobs for one
 * `plugin::upload.file` row. The work itself — probe, normalized MP4 + poster, optional
 * HLS ladder, atomic row switch — lives in video-pipeline.ts; this keeps the result shape
 * the story/product callers and backfill scripts already understand.
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
  /** `normalized` means the row or its delivery metadata changed during this call. */
  status: "skipped" | "normalized" | "would-normalize" | "missing";
  reasons?: string[];
  probe?: VideoProbe;
  durationMs?: number | null;
  detail?: string;
  video?: VideoMetadata | null;
}

export type NormalizeFileDeps = PipelineDeps & {
  /** Used by older call sites for output naming; the pipeline derives names itself. */
  nameHint?: string;
};

/** Another worker holds this file's processing lease; the caller should retry later. */
export class MediaBusyError extends Error {
  constructor(readonly fileId: number) {
    super(`video ${fileId} is being processed by another worker`);
    this.name = "MediaBusyError";
  }
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
  deps: NormalizeFileDeps,
): Promise<NormalizeFileResult> {
  const outcome = await processVideoFile(file.id, deps);
  switch (outcome.status) {
    case "missing":
      return { fileId: file.id, status: "missing", detail: outcome.detail };
    case "busy":
      throw new MediaBusyError(file.id);
    case "would_process":
      return {
        fileId: file.id,
        status: "would-normalize",
        reasons: outcome.reasons,
        probe: outcome.probe,
        durationMs: outcome.probe?.durationMs ?? null,
        detail: outcome.detail,
      };
    case "up_to_date":
      return {
        fileId: file.id,
        status: "skipped",
        reasons: outcome.detail ? [outcome.detail] : [],
        video: outcome.video,
        durationMs: outcome.video?.output?.durationMs ?? outcome.video?.source?.probe?.durationMs ?? null,
      };
    case "processed":
      return {
        fileId: file.id,
        status: "normalized",
        reasons: outcome.stages.map((stage) => `produced ${stage}`),
        video: outcome.video,
        durationMs: outcome.video.output?.durationMs ?? null,
      };
  }
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
