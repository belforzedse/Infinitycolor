/**
 * One-off backfill: normalize product gallery/cover videos already in the uploads volume.
 *
 * Same defect as stories: phone recordings and the WooCommerce import land as HEVC in a
 * QuickTime container (`video/quicktime`). Chromium without platform HEVC "plays" them
 * with audio over a blank frame and no `error` event. New uploads are handled by the
 * `media.normalizeProductVideo` queue job; this covers what is already stored.
 *
 * Dry run by default. Writes require BOTH `--apply` and an explicit `--product-ids` list,
 * so a mistyped command can never re-encode the whole catalogue.
 *
 *   node scripts/media/normalize-product-videos.js --dry-run
 *   node scripts/media/normalize-product-videos.js --apply --product-ids=4624
 *
 * Originals are left on disk and only the upload row is repointed, so a rollback is a
 * single row edit.
 */
import path from "node:path";
import {
  findProductsNeedingVideoNormalization,
  normalizeProductVideos,
  type NormalizeProductResult,
} from "../../src/services/media/normalize-product-video";
import { isFfmpegAvailable } from "../../src/services/media/video-normalization";

interface Options {
  apply: boolean;
  productIds: number[] | null;
}

function parseArgs(argv: string[]): Options {
  const apply = argv.includes("--apply");
  const idsArg = argv.find((arg) => arg.startsWith("--product-ids="));
  const productIds = idsArg
    ? idsArg
        .slice("--product-ids=".length)
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
    : null;
  return { apply, productIds };
}

function formatBytes(bytes?: number): string {
  if (!bytes) return "-";
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function describe(result: NormalizeProductResult): string {
  const parts = [`product ${result.productId}`, result.slug ?? "-", result.status];
  if (result.detail) parts.push(result.detail);
  for (const file of result.files) {
    const fileParts = [`file ${file.fileId}`, file.status];
    if (file.probe) {
      fileParts.push(
        `${file.probe.videoCodec ?? "?"}/${file.probe.audioCodec ?? "none"}`,
        `${file.probe.width ?? "?"}x${file.probe.height ?? "?"}`,
        `${((file.probe.durationMs ?? 0) / 1000).toFixed(1)}s`,
        file.probe.fastStart ? "faststart" : "moov-at-end",
      );
    }
    const output = file.video?.output;
    const sourceBytes = file.video?.source?.size ? file.video.source.size * 1024 : undefined;
    if (output) {
      fileParts.push(`${formatBytes(sourceBytes)} → ${formatBytes(output.mp4.bytes)}`);
    }
    if (file.reasons?.length) fileParts.push(`[${file.reasons.join("; ")}]`);
    if (file.detail) fileParts.push(file.detail);
    parts.push(fileParts.join(" "));
  }
  return parts.join(" | ");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dryRun = !options.apply;

  if (options.apply && !options.productIds?.length) {
    console.error(
      "[normalize] --apply requires an explicit --product-ids=... list. Run the dry run first and pass the ids it reports.",
    );
    process.exit(2);
  }

  if (!(await isFfmpegAvailable())) {
    console.error(
      "[normalize] ffmpeg/ffprobe not found. Run this inside the backend image (which installs them) or set FFMPEG_PATH/FFPROBE_PATH.",
    );
    process.exit(3);
  }

  const { createLoadedStrapi } = await import("../../src/queue/strapi-instance");
  const strapi = await createLoadedStrapi();
  const uploadsDir = path.join((strapi as any).dirs.static.public, "uploads");

  try {
    const targets = options.productIds ?? (await findProductsNeedingVideoNormalization(strapi as any));
    console.log(
      `[normalize] ${dryRun ? "DRY RUN" : "APPLYING"} — ${targets.length} product(s), uploads at ${uploadsDir}`,
    );

    const results: NormalizeProductResult[] = [];
    for (const productId of targets) {
      try {
        const result = await normalizeProductVideos(productId, {
          strapi: strapi as any,
          uploadsDir,
          dryRun,
        });
        results.push(result);
        process.stdout.write(`[normalize] ${describe(result)}\n`);
      } catch (error) {
        console.error(`[normalize] product ${productId} FAILED: ${(error as Error).message}`);
        results.push({
          productId,
          status: "missing",
          files: [],
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
      const ids = results.filter((r) => r.status === "would-normalize").map((r) => r.productId);
      if (ids.length) console.log(`[normalize] to apply: --apply --product-ids=${ids.join(",")}`);
    }
  } finally {
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
