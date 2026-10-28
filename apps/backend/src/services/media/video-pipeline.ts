import * as Sentry from "@sentry/node";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { writeMasterPlaylist } from "./hls-manifest";
import { FFMPEG, MediaProcessingError, runMediaProcess } from "./media-process";
import {
  buildHlsArgs,
  buildMp4Args,
  buildWebmArgs,
  buildPosterArgs,
  hlsSegmentSeconds,
  planEncode,
  posterSize,
  type EncodePlan,
} from "./video-encoding";
import {
  claimLease,
  readFileRow,
  releaseLease,
  renewLease,
  snapshotRow,
  writeVideoState,
  type FileRow,
  type ProbeSummary,
  type SqlClient,
  type VideoFailure,
  type VideoMetadata,
  type VideoOutput,
} from "./video-metadata";
import { hasFfmpegFilter, probeVideo, validateProbe, type VideoProbe } from "./video-normalization";
import {
  PIPELINE_VERSION,
  derivedBaseName,
  derivedFileNames,
  hlsDir,
  hlsMasterUrl,
  hlsParentDir,
  newAssetToken,
  processingDir,
  processingRoot,
  uploadFilePath,
} from "./video-paths";

/**
 * The video processing pipeline for one `plugin::upload.file` row.
 *
 *   Stage 1 — normalized faststart MP4 + poster, then one atomic row switch. From here the
 *             video plays everywhere, so a new post is never blocked on the HLS ladder.
 *   Stage 2 — HLS ladder (only when MEDIA_HLS_ENABLED), published by renaming a finished
 *             directory into place and then recording its master URL.
 *
 * Every trigger (upload, story, product and post saves, backfill) converges here. It is
 * idempotent — a finished row is a no-op — and exclusive: a lease on the row means two
 * workers can never encode the same file at once, and per-attempt tokens mean even a
 * lost lease cannot make two encoders write the same path.
 */

const LEASE_TTL_MS = 120_000;
const LEASE_RENEW_MS = 30_000;

/** Failures that re-running on the same file cannot fix. */
const PERMANENT_FAILURES = new Set([
  "no_video_stream",
  "duration_exceeded",
  "dimensions_exceeded",
  "probe_failed",
  "decode_failed",
  "hdr_tonemap_unavailable",
  "source_missing",
]);

export interface PipelineDeps {
  strapi: any;
  /** Absolute path of the directory Strapi serves `/uploads/*` from. */
  uploadsDir: string;
  dryRun?: boolean;
  hlsEnabled?: boolean;
  webmEnabled?: boolean;
  threads?: number;
  jobId?: string | null;
  attempt?: number;
  /** Reprocess rows the automatic triggers leave alone (rolled back, permanent failure). */
  force?: boolean;
}

export type PipelineOutcome =
  | { status: "missing"; fileId: number; detail: string }
  | { status: "busy"; fileId: number }
  | { status: "up_to_date"; fileId: number; video: VideoMetadata | null; detail?: string }
  | { status: "would_process"; fileId: number; reasons: string[]; probe?: VideoProbe; detail?: string }
  | { status: "processed"; fileId: number; stages: Array<"mp4" | "hls" | "webm">; video: VideoMetadata };

export interface ProcessingNeeds {
  mp4: boolean;
  hls: boolean;
  webm: boolean;
  reasons: string[];
}

export function readHlsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEDIA_HLS_ENABLED === "true";
}

export function readWebmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEDIA_WEBM_ENABLED === "true";
}

function readThreads(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.MEDIA_FFMPEG_THREADS);
  return Number.isInteger(value) && value > 0 ? value : 2;
}

function ownsRow(row: FileRow): boolean {
  const output = row.video?.output?.mp4?.url;
  return Boolean(output && output === row.url);
}

export function isVideoRow(row: Pick<FileRow, "mime" | "video">): boolean {
  return Boolean(row.video) || String(row.mime ?? "").toLowerCase().startsWith("video/");
}

/** What (if anything) a row needs. Pure; drives both the job and the backfill dry run. */
export function assessVideoRow(
  row: FileRow,
  { hlsEnabled, webmEnabled = false, force = false }: { hlsEnabled: boolean; webmEnabled?: boolean; force?: boolean },
): ProcessingNeeds {
  const video = row.video;
  const none = (reason: string): ProcessingNeeds => ({ mp4: false, hls: false, webm: false, reasons: [reason] });

  if (!force && video?.status === "rolled_back" && row.url === video.previous?.url) {
    return none("rolled back by an operator");
  }
  if (
    !force &&
    video?.status === "failed" &&
    video.failure &&
    PERMANENT_FAILURES.has(video.failure.code) &&
    video.failure.sourceUrl === row.url
  ) {
    return none(`failed permanently (${video.failure.code})`);
  }
  if (!ownsRow(row)) {
    const reason = !video
      ? "not processed yet"
      : video.output
        ? "row points at a different file than the pipeline output"
        : `status ${video.status}`;
    return { mp4: true, hls: hlsEnabled, webm: webmEnabled, reasons: [reason] };
  }
  if ((video?.pipelineVersion ?? 0) < PIPELINE_VERSION) {
    return {
      mp4: true,
      hls: hlsEnabled,
      webm: webmEnabled,
      reasons: [`pipeline v${video?.pipelineVersion ?? 0} is older than v${PIPELINE_VERSION}`],
    };
  }
  const hls = hlsEnabled && !video?.output?.hls && (force || !(video?.failure?.stage === "hls" && PERMANENT_FAILURES.has(video.failure.code)));
  const webm = webmEnabled && video?.output?.webm?.profileVersion !== 1 && (force || !video?.webmFailure ||
    video.webmFailure.sourceUrl !== row.url || (!PERMANENT_FAILURES.has(video.webmFailure.code) && video.webmFailure.attempt < 3));
  if (hls || webm) return { mp4: false, hls, webm, reasons: [...(hls ? ["no HLS rendition yet"] : []), ...(webm ? ["no WebM rendition yet"] : [])] };
  return none("up to date");
}

const LEGACY_SOURCE_EXTENSIONS = [".mov", ".MOV", ".mp4", ".MP4", ".m4v", ".webm", ".3gp", ".mkv"];
const MIME_BY_EXTENSION: Record<string, string> = {
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".3gp": "video/3gpp",
  ".mkv": "video/x-matroska",
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

type SourceRecord = NonNullable<VideoMetadata["source"]>;

/**
 * The file to encode from: the original upload, never a previous output. Rows the old
 * single-file transcoder repointed at `<hash>_web.mp4` still have their original on disk
 * under `<hash>.<ext>`; when it is gone, the `_web.mp4` itself is the best source left.
 */
export async function resolveSource(
  row: FileRow,
  uploadsDir: string,
): Promise<{ path: string; record: SourceRecord }> {
  if (ownsRow(row) && row.video?.source?.url) {
    const path = uploadFilePath(uploadsDir, row.video.source.url);
    if (!(await exists(path))) {
      throw new MediaProcessingError("source_missing", "the original upload is no longer on disk");
    }
    const { probe: _probe, ...record } = row.video.source;
    return { path, record };
  }
  if (!row.url) throw new MediaProcessingError("source_missing", "upload row has no url");

  const legacyBase = row.hash?.endsWith("_web") && row.url.endsWith("_web.mp4") ? row.hash.slice(0, -4) : null;
  if (legacyBase) {
    for (const extension of LEGACY_SOURCE_EXTENSIONS) {
      const path = uploadFilePath(uploadsDir, `/uploads/${legacyBase}${extension}`);
      if (await exists(path)) {
        return {
          path,
          record: {
            url: `/uploads/${legacyBase}${extension}`,
            name: row.name,
            hash: legacyBase,
            ext: extension,
            mime: MIME_BY_EXTENSION[extension.toLowerCase()] ?? null,
            size: Number(((await stat(path)).size / 1024).toFixed(2)),
          },
        };
      }
    }
  }

  const path = uploadFilePath(uploadsDir, row.url);
  if (!(await exists(path))) {
    throw new MediaProcessingError("source_missing", "the upload is not on disk");
  }
  return {
    path,
    record: { url: row.url, name: row.name, hash: row.hash, ext: row.ext, mime: row.mime, size: row.size },
  };
}

function summarizeProbe(probe: VideoProbe): ProbeSummary {
  return {
    container: probe.containerFormats.join(","),
    videoCodec: probe.videoCodec,
    videoProfile: probe.videoProfile,
    audioCodec: probe.audioCodec,
    width: probe.width,
    height: probe.height,
    displayWidth: probe.displayWidth,
    displayHeight: probe.displayHeight,
    rotation: probe.rotation,
    sampleAspectRatio: Math.round(probe.sampleAspectRatio * 1000) / 1000,
    frameRate: probe.frameRate && Math.round(probe.frameRate * 1000) / 1000,
    averageFrameRate: probe.averageFrameRate && Math.round(probe.averageFrameRate * 1000) / 1000,
    variableFrameRate: probe.variableFrameRate,
    pixelFormat: probe.pixelFormat,
    bitDepth: probe.bitDepth,
    colorPrimaries: probe.colorPrimaries,
    colorTransfer: probe.colorTransfer,
    colorSpace: probe.colorSpace,
    hdr: probe.hdr,
    dolbyVisionProfile: probe.dolbyVisionProfile,
    audioChannels: probe.audioChannels,
    durationMs: probe.durationMs,
    bitRate: probe.bitRate,
    fastStart: probe.fastStart,
  };
}

function encodeTimeoutMs(durationMs: number | null, stage: "mp4" | "hls" | "webm"): number {
  const seconds = (durationMs ?? 60_000) / 1000;
  return stage === "mp4"
    ? Math.min(30 * 60_000, 60_000 + seconds * 20_000)
    : Math.min(45 * 60_000, 120_000 + seconds * 40_000);
}

/** Output sanity: an encode that "succeeded" but is not what the plan asked for is a failure. */
export function verifyFallbackOutput(output: VideoProbe, plan: EncodePlan, source: VideoProbe, format: "mp4" | "webm" = "mp4"): void {
  const problems: string[] = [];
  if (output.videoCodec !== (format === "webm" ? "vp9" : "h264")) problems.push(`codec ${output.videoCodec}`);
  if (output.pixelFormat !== "yuv420p") problems.push(`pixel format ${output.pixelFormat}`);
  if (output.displayWidth !== plan.fallback.width || output.displayHeight !== plan.fallback.height) {
    problems.push(`size ${output.displayWidth}x${output.displayHeight}`);
  }
  if (output.rotation !== 0) problems.push(`rotation ${output.rotation}`);
  if (format === "mp4" && !output.fastStart) problems.push("moov not at front");
  if (plan.hasAudio && !output.hasAudio) problems.push("audio missing");
  if (format === "webm" && plan.hasAudio && output.audioCodec !== "opus") problems.push(`audio codec ${output.audioCodec}`);
  if (problems.length) {
    throw new MediaProcessingError("encode_failed", `output check failed: ${problems.join(", ")}`);
  }
  // A truncated upload decodes up to the break and exits 0; the duration gives it away.
  if (
    source.durationMs &&
    source.durationMs >= 1000 &&
    (output.durationMs ?? 0) < source.durationMs * 0.9
  ) {
    throw new MediaProcessingError(
      "decode_failed",
      "the source ended early; the upload is probably truncated",
    );
  }
}

function displayName(sourceName: string | null, fallback: string): string {
  const stem = (sourceName || fallback).replace(/\.[^./\\]+$/, "");
  return `${stem.slice(0, 240)}.mp4`;
}

async function removeStaleWorkDirs(uploadsDir: string, fileId: number): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(processingRoot(uploadsDir));
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`${fileId}-`))
      .map((entry) => rm(join(processingRoot(uploadsDir), entry), { recursive: true, force: true })),
  );
}

function logEvent(strapi: any, level: "info" | "warn" | "error", payload: Record<string, unknown>): void {
  // The Strapi logger drops metadata objects, so the structure travels in the message.
  strapi?.log?.[level]?.(`[media] ${JSON.stringify(payload)}`);
}

function toMediaError(error: unknown): MediaProcessingError {
  if (error instanceof MediaProcessingError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code && ["ENOSPC", "EACCES", "EPERM", "EIO", "EROFS", "ENOENT"].includes(code)) {
    return new MediaProcessingError("storage_error", `filesystem error ${code}`, String(error));
  }
  return new MediaProcessingError("unknown", (error as Error)?.message ?? String(error), (error as Error)?.stack);
}

class LeaseLostError extends MediaProcessingError {
  constructor() {
    super("terminated", "processing lease was lost to another worker");
  }
}

export async function processVideoFile(fileId: number, deps: PipelineDeps): Promise<PipelineOutcome> {
  const db: SqlClient = deps.strapi.db.connection;
  const row = await readFileRow(db, fileId);
  if (!row) return { status: "missing", fileId, detail: "upload row not found" };
  if (!isVideoRow(row)) return { status: "missing", fileId, detail: "not a video upload" };

  const hlsEnabled = deps.hlsEnabled ?? readHlsEnabled();
  const webmEnabled = deps.webmEnabled ?? readWebmEnabled();
  const needs = assessVideoRow(row, { hlsEnabled, webmEnabled, force: deps.force });
  if (!needs.mp4 && !needs.hls && !needs.webm) {
    return { status: "up_to_date", fileId, video: row.video, detail: needs.reasons.join("; ") };
  }

  if (deps.dryRun) {
    try {
      const { path } = await resolveSource(row, deps.uploadsDir);
      return { status: "would_process", fileId, reasons: needs.reasons, probe: await probeVideo(path) };
    } catch (error) {
      return { status: "would_process", fileId, reasons: needs.reasons, detail: (error as Error).message };
    }
  }

  const owner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  const jobId = deps.jobId ?? null;
  if (!(await claimLease(db, fileId, { owner, jobId, until: Date.now() + LEASE_TTL_MS }))) {
    return { status: "busy", fileId };
  }

  let leaseLost = false;
  const renewal = setInterval(() => {
    renewLease(db, fileId, owner, Date.now() + LEASE_TTL_MS)
      .then((held) => {
        if (!held) leaseLost = true;
      })
      .catch(() => undefined);
  }, LEASE_RENEW_MS);
  renewal.unref?.();

  const attempt = deps.attempt ?? 1;
  const threads = deps.threads ?? readThreads();
  const workDirs: string[] = [];
  const stages: Array<"mp4" | "hls" | "webm"> = [];
  let stage: VideoFailure["stage"] = !needs.mp4 && !needs.hls && needs.webm ? "webm" : "probe";
  let webmError: MediaProcessingError | undefined;
  let current: VideoMetadata | null = row.video;

  const write = async (patch: Partial<VideoMetadata>, rowUpdate?: Parameters<typeof writeVideoState>[4]) => {
    if (leaseLost) throw new LeaseLostError();
    const next = { ...patch, updatedAt: new Date().toISOString() };
    if (!(await writeVideoState(db, fileId, owner, next, rowUpdate))) throw new LeaseLostError();
    current = { ...(current ?? { schema: 1, status: "queued", updatedAt: next.updatedAt }), ...next } as VideoMetadata;
  };

  try {
    await removeStaleWorkDirs(deps.uploadsDir, fileId);
    await write({ schema: 1, status: needs.mp4 ? "probing" : "processing", ...(needs.mp4 || needs.hls ? { failure: null } : {}) });

    const source = await resolveSource(row, deps.uploadsDir);
    const probeStarted = Date.now();
    const probe = await probeVideo(source.path);
    validateProbe(probe);
    if (probe.hdr && !(await hasFfmpegFilter("zscale"))) {
      throw new MediaProcessingError(
        "hdr_tonemap_unavailable",
        "HDR source but this ffmpeg build has no zscale; refusing to produce a washed-out SDR copy",
      );
    }
    const plan = planEncode(probe);
    const timings: NonNullable<VideoMetadata["timings"]> = { probeMs: Date.now() - probeStarted };
    const warnings: string[] = [];
    if (probe.dolbyVisionProfile === 5) warnings.push("dolby_vision_profile_5_colors_approximate");

    if (needs.mp4) {
      stage = "mp4";
      await write({ status: "processing" });
      const token = newAssetToken();
      const work = processingDir(deps.uploadsDir, fileId, token);
      workDirs.push(work);
      await mkdir(work, { recursive: true });

      const tempMp4 = join(work, "fallback.mp4");
      const tempPoster = join(work, "poster.jpg");
      const mp4Started = Date.now();
      await runMediaProcess(FFMPEG, buildMp4Args(source.path, tempMp4, plan, { threads }), {
        timeoutMs: encodeTimeoutMs(probe.durationMs, "mp4"),
        lowPriority: true,
      });
      const encoded = await probeVideo(tempMp4);
      verifyFallbackOutput(encoded, plan, probe);
      timings.mp4Ms = Date.now() - mp4Started;

      // A poster is a nicety; a video that encodes but will not yield one still ships.
      let posterOk = false;
      const posterStarted = Date.now();
      try {
        await runMediaProcess(FFMPEG, buildPosterArgs(source.path, tempPoster, plan, probe.durationMs), {
          timeoutMs: 120_000,
          lowPriority: true,
        });
        posterOk = (await stat(tempPoster)).size > 0;
      } catch (error) {
        warnings.push("poster_failed");
        logEvent(deps.strapi, "warn", {
          event: "video.poster_failed",
          fileId,
          message: (error as Error).message,
        });
      }
      timings.posterMs = Date.now() - posterStarted;

      stage = "publish";
      const names = derivedFileNames(derivedBaseName(source.record.hash, fileId), token);
      const finalMp4 = join(deps.uploadsDir, names.mp4);
      await rename(tempMp4, finalMp4);
      if (posterOk) await rename(tempPoster, join(deps.uploadsDir, names.poster));
      const mp4Bytes = (await stat(finalMp4)).size;

      const output: VideoOutput = {
        token,
        width: plan.fallback.width,
        height: plan.fallback.height,
        fps: plan.fps.value,
        durationMs: encoded.durationMs,
        hasAudio: plan.hasAudio,
        mp4: { url: `/uploads/${names.mp4}`, bytes: mp4Bytes },
        poster: posterOk ? { url: `/uploads/${names.poster}`, ...posterSize(plan) } : null,
        hls: null,
      };
      await write(
        {
          status: "playback_ready",
          pipelineVersion: PIPELINE_VERSION,
          source: { ...source.record, probe: summarizeProbe(probe) },
          output,
          // Keep the very first pre-pipeline snapshot across re-encodes: that is what an
          // operator rollback should restore.
          previous: ownsRow(row) ? (row.video?.previous ?? null) : snapshotRow(row),
          failure: null,
          webmFailure: null,
          timings,
          warnings,
        },
        {
          url: output.mp4.url,
          name: displayName(source.record.name, names.hash),
          hash: names.hash,
          ext: ".mp4",
          mime: "video/mp4",
          size: Number((mp4Bytes / 1024).toFixed(2)),
          width: output.width,
          height: output.height,
          previewUrl: output.poster?.url ?? row.previewUrl,
        },
      );
      stages.push("mp4");
      await invalidateVideoReferences(deps.strapi, fileId);
    }

    if (needs.webm && current?.output) {
      try {
        stage = "webm";
        const token = newAssetToken();
        const work = processingDir(deps.uploadsDir, fileId, token);
        workDirs.push(work);
        await mkdir(work, { recursive: true });
        const temp = join(work, "fallback.webm");
        const started = Date.now();
        await runMediaProcess(FFMPEG, buildWebmArgs(source.path, temp, plan, { threads }), {
          timeoutMs: encodeTimeoutMs(probe.durationMs, "webm"), lowPriority: true,
        });
        verifyFallbackOutput(await probeVideo(temp), plan, probe, "webm");
        timings.webmMs = Date.now() - started;
        const name = `${derivedFileNames(derivedBaseName(source.record.hash, fileId), token).hash}.webm`;
        await rename(temp, join(deps.uploadsDir, name));
        await write({ output: { ...current.output, webm: { url: `/uploads/${name}`, bytes: (await stat(join(deps.uploadsDir, name))).size, profileVersion: 1 } }, webmFailure: null,
          status: current.output.hls ? "streaming_ready" : "playback_ready", timings: { ...current.timings, ...timings } });
        stages.push("webm");
        await invalidateVideoReferences(deps.strapi, fileId);
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        webmError = toMediaError(error);
        await write({ webmFailure: { stage: "webm", code: webmError.code, message: webmError.message.slice(0, 300),
          attempt: (row.video?.webmFailure?.attempt ?? 0) + 1, at: new Date().toISOString(), sourceUrl: current?.output?.mp4.url ?? row.url } });
      }
    }

    if (needs.hls && current?.output) {
      stage = "hls";
      const segmentSeconds = hlsSegmentSeconds();
      const token = newAssetToken();
      const work = processingDir(deps.uploadsDir, fileId, token);
      workDirs.push(work);
      const temp = join(work, "hls");
      await mkdir(temp, { recursive: true });

      const hlsStarted = Date.now();
      await runMediaProcess(
        FFMPEG,
        buildHlsArgs(source.path, temp, plan, { threads, segmentSeconds }),
        { timeoutMs: encodeTimeoutMs(probe.durationMs, "hls"), lowPriority: true },
      );
      const variants = await writeMasterPlaylist(temp, plan, segmentSeconds);
      timings.hlsMs = Date.now() - hlsStarted;

      stage = "publish";
      await mkdir(hlsParentDir(deps.uploadsDir, fileId), { recursive: true });
      await rename(temp, hlsDir(deps.uploadsDir, fileId, token));

      await write({
        status: "streaming_ready",
        output: {
          ...current.output,
          hls: {
            token,
            master: hlsMasterUrl(fileId, token),
            segmentSeconds,
            bytes: variants.reduce((sum, variant) => sum + variant.bytes, 0),
            renditions: variants.map((variant) => ({
              width: variant.width,
              height: variant.height,
              bandwidth: variant.bandwidth,
              averageBandwidth: variant.averageBandwidth,
              codecs: variant.codecs,
            })),
          },
        },
        failure: null,
        timings: { ...(current.timings ?? {}), ...timings },
      });
      stages.push("hls");
      await invalidateVideoReferences(deps.strapi, fileId);
    }

    if (webmError) { stage = "webm"; throw webmError; }
    logEvent(deps.strapi, "info", {
      event: "video.processed",
      fileId,
      stages,
      attempt,
      source: {
        codec: probe.videoCodec,
        size: `${probe.displayWidth}x${probe.displayHeight}`,
        fps: probe.averageFrameRate,
        vfr: probe.variableFrameRate,
        hdr: probe.hdr,
        rotation: probe.rotation,
        durationMs: probe.durationMs,
        bytes: source.record.size ? Math.round(source.record.size * 1024) : null,
      },
      output: current?.output
        ? {
            size: `${current.output.width}x${current.output.height}`,
            fps: current.output.fps,
            mp4Bytes: current.output.mp4.bytes,
            hlsBytes: current.output.hls?.bytes ?? null,
            renditions: current.output.hls?.renditions.map((rendition) => rendition.height) ?? null,
          }
        : null,
      timings,
    });

    return { status: "processed", fileId, stages, video: current as VideoMetadata };
  } catch (error) {
    const failure = toMediaError(error);
    if (!(failure instanceof LeaseLostError)) {
      const record: VideoFailure = {
        stage,
        code: failure.code,
        message: failure.message.slice(0, 300),
        attempt,
        at: new Date().toISOString(),
        sourceUrl: stages.includes("mp4") ? (current?.output?.mp4.url ?? row.url) : row.url,
      };
      // Whatever the row still points at keeps playing: a fresh MP4 from this run, or the
      // previous output when a re-encode failed. Only a row with nothing playable fails.
      const ready = stages.includes("mp4") || ownsRow(row);
      const status = ready && current?.output ? (current.output.hls ? "streaming_ready" : "playback_ready") : "failed";
      await writeVideoState(db, fileId, owner, { status, ...(stage === "webm" ? { webmFailure: webmError ? current?.webmFailure : { ...record, attempt: (row.video?.webmFailure?.attempt ?? 0) + 1 } } : { failure: record }), updatedAt: record.at }).catch(
        () => undefined,
      );
      logEvent(deps.strapi, "error", {
        event: "video.failed",
        fileId,
        stage,
        code: failure.code,
        retryable: failure.retryable,
        attempt,
        message: failure.message,
        detail: failure.detail?.slice(-600),
      });
      Sentry.captureMessage("media.video.failed", {
        level: failure.retryable ? "warning" : "error",
        tags: { media_failure_code: failure.code, media_stage: stage },
        extra: { fileId, attempt, message: failure.message, detail: failure.detail?.slice(-1500) },
      });
    }
    throw failure;
  } finally {
    clearInterval(renewal);
    await Promise.all(workDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    await releaseLease(db, fileId, owner).catch(() => undefined);
  }
}

/**
 * A row switch is a raw UPDATE, so no Strapi lifecycle fires and nothing downstream
 * notices. Clear what caches responses embedding this file's URL:
 *  - products: origin caches + storefront revalidation (same call the product save uses);
 *  - stories: served uncached by `/stories/active`;
 *  - posts: social caches its feed for 300s with no revalidation route — accepted; the
 *    previous URL keeps playing until it expires.
 */
export async function invalidateVideoReferences(strapi: any, fileId: number): Promise<{ products: number }> {
  try {
    const { rows } = await (strapi.db.connection as SqlClient).raw(
      `SELECT DISTINCT related_id FROM files_related_morphs WHERE file_id = ? AND related_type = ?`,
      [fileId, "api::product.product"],
    );
    const productIds = rows.map((entry) => Number(entry.related_id)).filter(Number.isInteger);
    if (productIds.length === 0) return { products: 0 };
    const products = await strapi.db.query("api::product.product").findMany({
      where: { id: { $in: productIds } },
      select: ["id", "Slug"],
    });
    const { clearProductOriginCaches } = await import("../../utils/productOriginCache");
    for (const product of products ?? []) {
      if (!product?.Slug) continue;
      await clearProductOriginCaches(strapi, product.Slug, {
        availabilityCrossed: false,
        logPrefix: "video-pipeline",
      });
    }
    return { products: productIds.length };
  } catch (error) {
    logEvent(strapi, "warn", {
      event: "video.invalidate_failed",
      fileId,
      message: (error as Error).message,
    });
    return { products: 0 };
  }
}
