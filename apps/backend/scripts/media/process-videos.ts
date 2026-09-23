/**
 * Backfill, reprocess and roll back video uploads through the media pipeline.
 *
 * Covers every video `plugin::upload.file` row — stories, products and posts alike —
 * including rows the old single-file transcoder repointed at `<hash>_web.mp4` and rows
 * nothing ever processed (the media queue's ids were rejected by BullMQ until 2026-09-23,
 * so uploads after the manual backfills were never transcoded).
 *
 * Dry run by default. Writes need an explicit scope, so a mistyped command can never
 * re-encode the whole catalogue:
 *
 *   node dist/scripts/media/process-videos.js                         # dry run: candidates + reasons
 *   node dist/scripts/media/process-videos.js --probe                 # …plus an ffprobe of each source
 *   node dist/scripts/media/process-videos.js --apply --file-ids=1,2  # queue those files for the media worker
 *   node dist/scripts/media/process-videos.js --apply --limit=20      # queue the 20 newest candidates
 *   node dist/scripts/media/process-videos.js --apply --inline --file-ids=1   # process here instead of queueing
 *   node dist/scripts/media/process-videos.js --rollback --file-ids=1 # restore the pre-pipeline row
 *   node dist/scripts/media/process-videos.js --prune-report          # list superseded derived files (deletes nothing)
 *
 * `--force` also reprocesses rows the automatic triggers skip (permanent failures,
 * operator rollbacks). `--hls` / `--no-hls` override MEDIA_HLS_ENABLED for this run.
 * Originals are never deleted; a rollback is always possible.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readFileRow, rollbackRow, type FileRow } from "../../src/services/media/video-metadata";
import { isFfmpegAvailable } from "../../src/services/media/video-normalization";
import {
  assessVideoRow,
  processVideoFile,
  readHlsEnabled,
  type PipelineOutcome,
} from "../../src/services/media/video-pipeline";

interface Options {
  apply: boolean;
  inline: boolean;
  rollback: boolean;
  pruneReport: boolean;
  probe: boolean;
  force: boolean;
  hls: boolean;
  fileIds: number[] | null;
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const ids = value("--file-ids");
  const limit = Number(value("--limit"));
  return {
    apply: argv.includes("--apply"),
    inline: argv.includes("--inline"),
    rollback: argv.includes("--rollback"),
    pruneReport: argv.includes("--prune-report"),
    probe: argv.includes("--probe"),
    force: argv.includes("--force"),
    hls: argv.includes("--hls") ? true : argv.includes("--no-hls") ? false : readHlsEnabled(),
    fileIds: ids
      ? ids.split(",").map((id) => Number(id.trim())).filter((id) => Number.isInteger(id) && id > 0)
      : null,
    limit: Number.isInteger(limit) && limit > 0 ? limit : null,
  };
}

const log = (line: string) => process.stdout.write(`[process-videos] ${line}\n`);

async function listVideoRowIds(db: any, fileIds: number[] | null): Promise<number[]> {
  const { rows } = await db.raw(
    `SELECT id FROM files
      WHERE (mime ILIKE 'video/%' OR (provider_metadata -> 'video') IS NOT NULL)
        ${fileIds ? "AND id = ANY(?)" : ""}
      ORDER BY id DESC`,
    fileIds ? [fileIds] : [],
  );
  return rows.map((row: { id: number }) => Number(row.id));
}

function describeRow(row: FileRow): string {
  const video = row.video;
  const parts = [`file ${row.id}`, row.mime ?? "?", row.url ?? "-", `status=${video?.status ?? "legacy"}`];
  if (video?.failure) parts.push(`failure=${video.failure.stage}/${video.failure.code}`);
  if (video?.lease) parts.push(`lease=${video.lease.owner} until ${new Date(video.lease.until).toISOString()}`);
  return parts.join(" ");
}

function describeOutcome(outcome: PipelineOutcome): string {
  switch (outcome.status) {
    case "processed":
      return `processed ${outcome.stages.join("+")} → ${outcome.video.output?.mp4.url}` +
        (outcome.video.output?.hls ? ` + ${outcome.video.output.hls.master}` : "");
    case "would_process": {
      const probe = outcome.probe;
      const source = probe
        ? ` source ${probe.videoCodec}/${probe.audioCodec ?? "none"} ${probe.displayWidth}x${probe.displayHeight}` +
          ` ${((probe.durationMs ?? 0) / 1000).toFixed(1)}s ${probe.averageFrameRate?.toFixed(2)}fps` +
          `${probe.hdr ? ` ${probe.hdr}` : ""}${probe.rotation ? ` rot${probe.rotation}` : ""}`
        : "";
      return `would process [${outcome.reasons.join("; ")}]${source}${outcome.detail ? ` (${outcome.detail})` : ""}`;
    }
    case "up_to_date":
      return `up to date${outcome.detail ? ` (${outcome.detail})` : ""}`;
    case "busy":
      return "busy (another worker holds the lease)";
    case "missing":
      return `missing (${outcome.detail})`;
  }
}

async function pruneReport(db: any, uploadsDir: string): Promise<void> {
  const videoRoot = path.join(uploadsDir, "video");
  let fileDirs: string[] = [];
  try {
    fileDirs = await readdir(videoRoot);
  } catch {
    log("no derived HLS directories");
    return;
  }
  let superseded = 0;
  for (const fileDir of fileDirs) {
    const fileId = Number(fileDir);
    if (!Number.isInteger(fileId)) continue;
    const row = await readFileRow(db, fileId);
    const live = row?.video?.output?.hls?.token;
    for (const token of await readdir(path.join(videoRoot, fileDir))) {
      if (token === live) continue;
      superseded += 1;
      log(`superseded HLS ${path.join("video", fileDir, token)} (row ${row ? `live=${live ?? "none"}` : "deleted"})`);
    }
  }
  log(`${superseded} superseded HLS director${superseded === 1 ? "y" : "ies"}; nothing deleted`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const writes = options.apply || options.rollback;

  if (writes && !options.fileIds?.length && !(options.apply && options.limit)) {
    console.error(
      "[process-videos] writes need an explicit scope: --file-ids=... (or --limit=N with --apply). Run the dry run first.",
    );
    process.exit(2);
  }
  if ((options.inline || options.probe) && !(await isFfmpegAvailable())) {
    console.error("[process-videos] ffmpeg/ffprobe not found; run inside the backend image or set FFMPEG_PATH/FFPROBE_PATH.");
    process.exit(3);
  }

  const { createLoadedStrapi } = await import("../../src/queue/strapi-instance");
  const strapi = (await createLoadedStrapi()) as any;
  const db = strapi.db.connection;
  const uploadsDir = path.join(strapi.dirs.static.public, "uploads");

  try {
    if (options.pruneReport) {
      await pruneReport(db, uploadsDir);
      return;
    }

    const ids = await listVideoRowIds(db, options.fileIds);

    if (options.rollback) {
      for (const id of ids) {
        const row = await readFileRow(db, id);
        if (!row) continue;
        const done = await rollbackRow(db, row);
        log(`${describeRow(row)} → ${done ? `rolled back to ${row.video?.previous?.url}` : "not rolled back (no pipeline output is live on this row)"}`);
      }
      return;
    }

    const candidates: FileRow[] = [];
    for (const id of ids) {
      const row = await readFileRow(db, id);
      if (!row) continue;
      const needs = assessVideoRow(row, { hlsEnabled: options.hls, force: options.force });
      if (!needs.mp4 && !needs.hls) {
        if (options.fileIds) log(`${describeRow(row)} → up to date (${needs.reasons.join("; ")})`);
        continue;
      }
      candidates.push(row);
    }
    const scoped = options.apply && options.limit ? candidates.slice(0, options.limit) : candidates;
    log(`${options.apply ? (options.inline ? "PROCESSING" : "QUEUEING") : "DRY RUN"} — ${scoped.length} of ${candidates.length} candidate(s), HLS ${options.hls ? "on" : "off"}, uploads at ${uploadsDir}`);

    const counts: Record<string, number> = {};
    for (const row of scoped) {
      try {
        if (!options.apply) {
          const outcome = options.probe
            ? await processVideoFile(row.id, { strapi, uploadsDir, dryRun: true, hlsEnabled: options.hls, force: options.force })
            : ({
                status: "would_process",
                fileId: row.id,
                reasons: assessVideoRow(row, { hlsEnabled: options.hls, force: options.force }).reasons,
              } as PipelineOutcome);
          counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
          log(`${describeRow(row)} → ${describeOutcome(outcome)}`);
        } else if (options.inline) {
          const outcome = await processVideoFile(row.id, {
            strapi,
            uploadsDir,
            hlsEnabled: options.hls,
            force: options.force,
            jobId: "process-videos-inline",
          });
          counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
          log(`${describeRow(row)} → ${describeOutcome(outcome)}`);
        } else {
          const { enqueueVideoProcessingFor } = await import("../../src/queue/media");
          await enqueueVideoProcessingFor(row.id, options.force ? "backfill-force" : "backfill", undefined, {
            force: options.force,
          });
          counts.queued = (counts.queued ?? 0) + 1;
          log(`${describeRow(row)} → queued`);
        }
      } catch (error) {
        // One bad file must not abandon the rest of the batch.
        counts.failed = (counts.failed ?? 0) + 1;
        log(`${describeRow(row)} → FAILED: ${(error as Error).message}`);
      }
    }

    log(`summary ${JSON.stringify(counts)}`);
    if (!options.apply && scoped.length) {
      log(`to apply: --apply --file-ids=${scoped.map((row) => row.id).join(",")}`);
    }
    if (options.apply && !options.inline) {
      const { closeMediaQueues } = await import("../../src/queue/media");
      await closeMediaQueues();
    }
  } finally {
    // A loaded Strapi keeps DB/Redis handles open and its destroy() can hang; this is a
    // one-shot container, so bound the shutdown.
    await Promise.race([
      strapi.destroy?.() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]).catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[process-videos] failed:", error);
    process.exit(1);
  });
