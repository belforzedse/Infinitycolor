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
 * Normalizes the video attached to a single story, in place on the uploads volume.
 *
 * The new file is written beside the original under a new name and the existing
 * `plugin::upload.file` row is repointed at it. Doing it this way rather than through the
 * upload service keeps us off a version-specific API, leaves the original on disk so a
 * rollback is a single row edit, and — because the URL changes — sidesteps the
 * `immutable` year-long CDN cache on the old path.
 */

export interface StoryUploadFile {
  id: number;
  name?: string | null;
  url?: string | null;
  mime?: string | null;
  ext?: string | null;
  hash?: string | null;
  size?: number | null;
}

export interface NormalizeResult {
  storyId: number;
  fileId: number | null;
  status: "skipped" | "normalized" | "would-normalize" | "missing";
  decision?: NormalizationDecision;
  probe?: VideoProbe;
  fromBytes?: number;
  toBytes?: number;
  durationMs?: number | null;
  detail?: string;
}

export interface NormalizeDeps {
  strapi: any;
  /** Absolute path of the directory Strapi serves `/uploads/*` from. */
  uploadsDir: string;
  dryRun?: boolean;
}

function uploadFilePath(uploadsDir: string, url: string): string {
  // Local provider URLs are always `/uploads/<name>`; guard against anything else so we
  // never write outside the uploads volume.
  const name = url.replace(/^.*\/uploads\//, "");
  if (!name || name.includes("..") || name.includes("/")) {
    throw new Error(`unexpected upload url: ${url}`);
  }
  return join(uploadsDir, name);
}

export async function normalizeStoryVideo(
  storyId: number,
  { strapi, uploadsDir, dryRun = false }: NormalizeDeps,
): Promise<NormalizeResult> {
  const story = await strapi.entityService.findOne("api::story.story", storyId, {
    populate: { Media: true },
  });

  if (!story || story.MediaType !== "video" || !story.Media?.url) {
    return { storyId, fileId: story?.Media?.id ?? null, status: "missing", detail: "no video media" };
  }

  const file = story.Media as StoryUploadFile;
  const sourcePath = uploadFilePath(uploadsDir, file.url!);

  try {
    await stat(sourcePath);
  } catch {
    return { storyId, fileId: file.id, status: "missing", detail: `not on disk: ${sourcePath}` };
  }

  const probe = await probeVideo(sourcePath);
  const decision = decideNormalization(probe, { mime: file.mime, extension: extname(sourcePath) });

  if (!decision.needed) {
    // Still worth correcting a duration the admin guessed wrong, which is the case for
    // almost every imported story.
    await syncDuration(strapi, story, probe.durationMs, dryRun);
    return { storyId, fileId: file.id, status: "skipped", decision, probe, durationMs: probe.durationMs };
  }

  if (dryRun) {
    return {
      storyId,
      fileId: file.id,
      status: "would-normalize",
      decision,
      probe,
      fromBytes: (await stat(sourcePath)).size,
      durationMs: probe.durationMs,
    };
  }

  const baseName = (file.hash || `story-${storyId}`).replace(/[^\w.-]/g, "_");
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

  await syncDuration(strapi, story, outputProbe.durationMs, false);

  return {
    storyId,
    fileId: file.id,
    status: "normalized",
    decision,
    probe,
    fromBytes,
    toBytes,
    durationMs: outputProbe.durationMs,
  };
}

/**
 * The imported rows carry DurationMs: 3000 for clips that actually run 10–22s. The
 * viewer reads the real duration off the element, so this only keeps the stored value
 * honest for the admin UI and for image-style fallbacks.
 */
async function syncDuration(
  strapi: any,
  story: { id: number; DurationMs?: number | null },
  durationMs: number | null | undefined,
  dryRun: boolean,
): Promise<void> {
  if (dryRun || !durationMs || durationMs < 1000) return;
  if (story.DurationMs === durationMs) return;
  await strapi.entityService.update("api::story.story", story.id, {
    data: { DurationMs: durationMs },
  });
}

/** Story ids whose attached video still needs normalization. */
export async function findStoriesNeedingNormalization(strapi: any): Promise<number[]> {
  const stories = await strapi.entityService.findMany("api::story.story", {
    filters: { MediaType: "video" },
    populate: { Media: true },
    limit: 500,
  });
  return (stories ?? [])
    .filter((story: any) => {
      const mime = String(story?.Media?.mime ?? "").toLowerCase();
      const url = String(story?.Media?.url ?? "");
      // Cheap pre-filter so the queue only probes files that look suspect; the job
      // re-probes and can still decide to skip.
      return mime !== "video/mp4" && mime !== "video/webm" && Boolean(url);
    })
    .map((story: any) => story.id);
}
