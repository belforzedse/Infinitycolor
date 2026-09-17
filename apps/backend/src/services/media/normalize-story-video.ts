import {
  collectVideoUploads,
  isVideoUpload,
  looksLikeUnsafeWebVideo,
  normalizeUploadFile,
  type NormalizeFileDeps,
  type NormalizeFileResult,
  type UploadVideoFile,
} from "./normalize-upload-video";

export type StoryUploadFile = UploadVideoFile;

export interface NormalizeResult extends NormalizeFileResult {
  storyId: number;
}

export type NormalizeDeps = NormalizeFileDeps;

export async function normalizeStoryVideo(
  storyId: number,
  deps: NormalizeDeps,
): Promise<NormalizeResult> {
  const story = await deps.strapi.entityService.findOne("api::story.story", storyId, {
    populate: { Media: true },
  });

  if (!story || story.MediaType !== "video" || !story.Media?.url) {
    return { storyId, fileId: story?.Media?.id ?? null, status: "missing", detail: "no video media" };
  }

  const file = story.Media as UploadVideoFile;
  const result = await normalizeUploadFile(file, { ...deps, nameHint: `story-${storyId}` });

  if (result.status === "skipped" || result.status === "normalized") {
    await syncDuration(deps.strapi, story, result.durationMs, Boolean(deps.dryRun));
  }

  return { storyId, ...result };
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
    .filter((story: any) => looksLikeUnsafeWebVideo(story?.Media) && Boolean(story?.Media?.url))
    .map((story: any) => story.id);
}

export { collectVideoUploads, isVideoUpload, looksLikeUnsafeWebVideo };
