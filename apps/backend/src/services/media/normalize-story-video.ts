import {
  collectVideoUploads,
  isVideoUpload,
  looksLikeUnsafeWebVideo,
  normalizeUploadFile,
  type NormalizeFileDeps,
  type NormalizeFileResult,
  type UploadVideoFile,
} from "./normalize-upload-video";
import { extractRelationId, legacyStoryItemKey } from "../../api/story/lib/story-items";

export type StoryUploadFile = UploadVideoFile;

export interface NormalizeResult extends NormalizeFileResult {
  storyId: number;
  itemKey: string;
}

export type NormalizeDeps = NormalizeFileDeps;

type StoryItem = {
  id?: number;
  Key: string;
  MediaType: "image" | "video";
  Media?: UploadVideoFile | null;
  DurationMs?: number | null;
  [key: string]: unknown;
};

function storyItems(story: any): StoryItem[] {
  if (Array.isArray(story?.Items) && story.Items.length) return story.Items;
  if (!story?.id) return [];
  return [
    {
      Key: legacyStoryItemKey(story.id),
      MediaType: story.MediaType,
      Media: story.Media,
      DurationMs: story.DurationMs,
    },
  ];
}

export async function normalizeStoryVideo(
  storyId: number,
  itemKey: string,
  expectedFileId: number,
  deps: NormalizeDeps,
): Promise<NormalizeResult> {
  const story = await deps.strapi.entityService.findOne("api::story.story", storyId, {
    populate: { Items: { populate: { Media: true, Thumbnail: true } }, Media: true },
  });
  const item = storyItems(story).find((candidate) => candidate.Key === itemKey);
  const fileId = extractRelationId(item?.Media);
  if (!story || !item || item.MediaType !== "video" || !item.Media?.url) {
    return { storyId, itemKey, fileId: fileId ?? null, status: "missing", detail: "no video item" };
  }
  if (fileId !== expectedFileId) {
    return {
      storyId,
      itemKey,
      fileId: fileId ?? null,
      status: "missing",
      detail: "item media changed",
    };
  }

  const result = await normalizeUploadFile(item.Media, {
    ...deps,
    nameHint: `story-${storyId}-${itemKey}`,
  });
  if (result.status === "skipped" || result.status === "normalized") {
    await syncItemDuration(
      deps.strapi,
      storyId,
      itemKey,
      expectedFileId,
      result.durationMs,
      Boolean(deps.dryRun),
    );
  }
  return { storyId, itemKey, ...result };
}

/** Reload immediately before the write and preserve every other component entry. */
async function syncItemDuration(
  strapi: any,
  storyId: number,
  itemKey: string,
  expectedFileId: number,
  durationMs: number | null | undefined,
  dryRun: boolean,
): Promise<void> {
  if (dryRun || !durationMs || durationMs < 1000) return;
  const latest = await strapi.entityService.findOne("api::story.story", storyId, {
    populate: { Items: { populate: { Media: true, Thumbnail: true } }, Media: true },
  });
  if (!latest) return;

  if (!Array.isArray(latest.Items) || latest.Items.length === 0) {
    if (
      itemKey === legacyStoryItemKey(storyId) &&
      extractRelationId(latest.Media) === expectedFileId &&
      latest.DurationMs !== durationMs
    ) {
      await strapi.entityService.update("api::story.story", storyId, {
        data: { DurationMs: durationMs },
      });
    }
    return;
  }

  let changed = false;
  const Items = latest.Items.map((item: StoryItem) => {
    if (item.Key !== itemKey || extractRelationId(item.Media) !== expectedFileId) return item;
    if (item.DurationMs === durationMs) return item;
    changed = true;
    return { ...item, DurationMs: durationMs };
  });
  if (changed) {
    await strapi.entityService.update("api::story.story", storyId, { data: { Items } });
  }
}

export type StoryVideoNormalizationTarget = {
  storyId: number;
  itemKey: string;
  fileId: number;
};

export async function findStoryVideosNeedingNormalization(
  strapi: any,
): Promise<StoryVideoNormalizationTarget[]> {
  const stories = await strapi.entityService.findMany("api::story.story", {
    populate: { Items: { populate: { Media: true } }, Media: true },
    limit: 500,
  });
  const targets: StoryVideoNormalizationTarget[] = [];
  for (const story of stories ?? []) {
    for (const item of storyItems(story)) {
      const fileId = extractRelationId(item.Media);
      if (
        item.MediaType === "video" &&
        fileId &&
        item.Media?.url &&
        looksLikeUnsafeWebVideo(item.Media)
      ) {
        targets.push({ storyId: story.id, itemKey: item.Key, fileId });
      }
    }
  }
  return targets;
}

/** Backward-compatible helper used by older operational scripts. */
export async function findStoriesNeedingNormalization(strapi: any): Promise<number[]> {
  return [...new Set((await findStoryVideosNeedingNormalization(strapi)).map((target) => target.storyId))];
}

export { collectVideoUploads, isVideoUpload, looksLikeUnsafeWebVideo };

