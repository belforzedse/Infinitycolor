import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * Derived-asset paths. Everything the pipeline writes lives under the shared uploads
 * volume (so `rename` is atomic and the gateway serves it as-is) at names built only from
 * the numeric file id and a random token — never from user-supplied names.
 *
 *   uploads/<base>_<token>.mp4          normalized progressive MP4 (the row's `url`)
 *   uploads/<base>_<token>.jpg          poster (the row's `previewUrl`)
 *   uploads/video/<fileId>/<token>/     HLS: master.m3u8 + r<rung>/{index.m3u8,init.mp4,seg_NNN.m4s}
 *   uploads/.processing/<fileId>-<token>/   work area, never referenced by a row
 *
 * Tokens are fresh per attempt, so a re-encode can never overwrite files a live row (or a
 * CDN edge holding an `immutable` copy) points at.
 */

/** Bump when the encode profile changes in a way worth re-processing existing assets for. */
export const PIPELINE_VERSION = 1;

const TOKEN_PATTERN = /^v\d+-[0-9a-f]{8}$/;

export function newAssetToken(version = PIPELINE_VERSION): string {
  return `v${version}-${randomBytes(4).toString("hex")}`;
}

function assertFileId(fileId: number): void {
  if (!Number.isInteger(fileId) || fileId <= 0) throw new Error(`invalid file id: ${fileId}`);
}

function assertToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) throw new Error(`invalid asset token: ${token}`);
}

/** Absolute path of a local-provider upload. Rejects anything outside the uploads root. */
export function uploadFilePath(uploadsDir: string, url: string): string {
  // Local provider URLs are always `/uploads/<name>`; guard against anything else so we
  // never read or write outside the uploads volume.
  const name = url.replace(/^.*\/uploads\//, "");
  if (!name || name.includes("..") || name.includes("/")) {
    throw new Error(`unexpected upload url: ${url}`);
  }
  return join(uploadsDir, name);
}

export function processingRoot(uploadsDir: string): string {
  return join(uploadsDir, ".processing");
}

export function processingDir(uploadsDir: string, fileId: number, token: string): string {
  assertFileId(fileId);
  assertToken(token);
  return join(processingRoot(uploadsDir), `${fileId}-${token}`);
}

export function hlsParentDir(uploadsDir: string, fileId: number): string {
  assertFileId(fileId);
  return join(uploadsDir, "video", String(fileId));
}

export function hlsDir(uploadsDir: string, fileId: number, token: string): string {
  assertToken(token);
  return join(hlsParentDir(uploadsDir, fileId), token);
}

export function hlsMasterUrl(fileId: number, token: string): string {
  assertFileId(fileId);
  assertToken(token);
  return `/uploads/video/${fileId}/${token}/master.m3u8`;
}

/**
 * Stable, filesystem-safe stem for derived files, taken from the *original* upload's hash
 * so reprocessing a row never stacks suffixes (`x_web_v1-…_v2-…`).
 */
export function derivedBaseName(sourceHash: string | null | undefined, fileId: number): string {
  const stem = String(sourceHash || `file-${fileId}`)
    // Earlier pipelines' suffixes: the single-file `_web` transcode and our own tokens.
    .replace(/(_web|_v\d+-[0-9a-f]{8})+$/, "")
    .replace(/[^\w.-]/g, "_")
    .slice(0, 120);
  return stem || `file-${fileId}`;
}

export function derivedFileNames(base: string, token: string): { hash: string; mp4: string; poster: string } {
  assertToken(token);
  const hash = `${base}_${token}`;
  return { hash, mp4: `${hash}.mp4`, poster: `${hash}.jpg` };
}
