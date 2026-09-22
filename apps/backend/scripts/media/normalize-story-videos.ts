/**
 * One-off backfill: normalize the story videos already in the uploads volume.
 *
 * The production catalogue was imported from WooCommerce and is almost entirely HEVC in a
 * QuickTime container — unplayable in Chromium builds without platform HEVC, where it
 * decodes nothing and reports no error. New uploads are handled by the `media` queue job;
 * this covers what is already stored.
 *
 * Dry run by default. Writes require BOTH `--apply` and an explicit `--story-ids` list,
 * so a mistyped command can never re-encode the whole catalogue.
 *
 *   node scripts/media/normalize-story-videos.js --dry-run
 *   node scripts/media/normalize-story-videos.js --apply --story-ids=9,10,11
 *
 * Originals are left on disk and only the upload row is repointed, so a rollback is a
 * single row edit.
 */
import path from "node:path";
import {
  findStoryVideosNeedingNormalization,
  normalizeStoryVideo,
  type NormalizeResult,
} from "../../src/services/media/normalize-story-video";
import { isFfmpegAvailable } from "../../src/services/media/video-normalization";

interface Options {
  apply: boolean;
  storyIds: number[] | null;
}

function parseArgs(argv: string[]): Options {
  const apply = argv.includes("--apply");
  const idsArg = argv.find((arg) => arg.startsWith("--story-ids="));
  const storyIds = idsArg
    ? idsArg
        .slice("--story-ids=".length)
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
    : null;
  return { apply, storyIds };
}

function formatBytes(bytes?: number): string {
  if (!bytes) return "-";
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function describe(result: NormalizeResult): string {
  const parts = [`story ${result.storyId}`, result.status];
  if (result.probe) {
    parts.push(
      `${result.probe.videoCodec ?? "?"}/${result.probe.audioCodec ?? "none"}`,
      `${result.probe.width ?? "?"}x${result.probe.height ?? "?"}`,
      `${((result.probe.durationMs ?? 0) / 1000).toFixed(1)}s`,
      result.probe.fastStart ? "faststart" : "moov-at-end",
    );
  }
  if (result.fromBytes) parts.push(`${formatBytes(result.fromBytes)} → ${formatBytes(result.toBytes)}`);
  if (result.decision?.reasons.length) parts.push(`[${result.decision.reasons.join("; ")}]`);
  if (result.detail) parts.push(result.detail);
  return parts.join(" | ");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dryRun = !options.apply;

  if (options.apply && !options.storyIds?.length) {
    console.error(
      "[normalize] --apply requires an explicit --story-ids=... list. Run the dry run first and pass the ids it reports.",
    );
    process.exit(2);
  }

  if (!(await isFfmpegAvailable())) {
    console.error(
      "[normalize] ffmpeg/ffprobe not found. Run this inside the backend image (which installs them) or set FFMPEG_PATH/FFPROBE_PATH.",
    );
    process.exit(3);
  }

  // Loading Strapi is what gives us entityService plus the configured uploads directory.
  const { createLoadedStrapi } = await import("../../src/queue/strapi-instance");
  const strapi = await createLoadedStrapi();
  const uploadsDir = path.join((strapi as any).dirs.static.public, "uploads");

  try {
    const discovered = await findStoryVideosNeedingNormalization(strapi as any);
    const targets = options.storyIds
      ? discovered.filter((target) => options.storyIds?.includes(target.storyId))
      : discovered;
    console.log(
      `[normalize] ${dryRun ? "DRY RUN" : "APPLYING"} — ${targets.length} story/stories, uploads at ${uploadsDir}`,
    );

    const results: NormalizeResult[] = [];
    for (const target of targets) {
      try {
        const result = await normalizeStoryVideo(
          target.storyId,
          target.itemKey,
          target.fileId,
          { strapi: strapi as any, uploadsDir, dryRun },
        );
        results.push(result);
        process.stdout.write(`[normalize] ${describe(result)}\n`);
      } catch (error) {
        // One bad file must not abandon the rest of the batch.
        console.error(`[normalize] story ${target.storyId} FAILED: ${(error as Error).message}`);
        results.push({
          storyId: target.storyId,
          itemKey: target.itemKey,
          fileId: null,
          status: "missing",
          detail: (error as Error).message,
        });
      }
    }

    const counts = results.reduce<Record<string, number>>((acc, result) => {
      acc[result.status] = (acc[result.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`[normalize] summary ${JSON.stringify(counts)}`);
    if (dryRun) {
      const ids = results.filter((r) => r.status === "would-normalize").map((r) => r.storyId);
      if (ids.length) console.log(`[normalize] to apply: --apply --story-ids=${ids.join(",")}`);
    }
  } finally {
    // A loaded Strapi keeps DB/Redis handles open and its destroy() can hang; this is a
    // one-shot container, so bound the shutdown rather than leaving an operator watching
    // a container that has already done its work.
    await Promise.race([
      (strapi as any).destroy?.() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]).catch(() => undefined);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("[normalize] failed:", error);
    process.exit(1);
  });
