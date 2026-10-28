import { readVideoDelivery } from "@repo/video-player";
import type {
  ResolveStoryMediaUrl,
  StoryRailItem,
  StoryRailPreview,
  StoryRailStory,
  StorySeenItems,
} from "./types";

export function getStorySortTimestamp(story: StoryRailStory): number {
  const value = story.updatedAt || story.createdAt;
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortStoriesNewestFirst<TStory extends StoryRailStory>(stories: TStory[]): TStory[] {
  return [...stories].sort((a, b) => {
    const timestampDiff = getStorySortTimestamp(b) - getStorySortTimestamp(a);
    if (timestampDiff !== 0) return timestampDiff;
    return b.id - a.id;
  });
}

export function hasUsableMediaUrl(url?: string): url is string {
  return typeof url === "string" && url.trim().length > 0;
}

/** Defense in depth for legacy rows that may predate backend CTA validation. */
export function getSafeStoryCtaUrl(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.length > 500 || /[\u0000-\u001F\u007F\\]/.test(candidate)) {
    return undefined;
  }

  if (candidate.startsWith("/")) {
    if (candidate.startsWith("//")) return undefined;
    try {
      const parsed = new URL(candidate, "https://storefront.invalid");
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return undefined;
    }
  }

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function isSupportedImageUrl(url: string): boolean {
  return /\.(avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(url);
}

export function isSupportedVideoUrl(url: string): boolean {
  return /\.(m3u8|mov|mp4|m4v|ogg|ogv|webm)(?:[?#].*)?$/i.test(url);
}

export function getStoryItems(story: StoryRailStory): StoryRailItem[] {
  if (Array.isArray(story.Items) && story.Items.length) return story.Items;
  return [{
    Key: `legacy:${story.id}`,
    MediaType: story.MediaType,
    Media: story.Media,
    Thumbnail: story.Thumbnail,
    DurationMs: story.DurationMs,
    CtaUrl: story.CtaUrl,
  }];
}

export function isImageStory(item: StoryRailItem): boolean {
  const mediaUrl = item.Media?.url;
  if (item.MediaType !== "image" || !hasUsableMediaUrl(mediaUrl)) return false;
  const mime = item.Media?.mime;
  return mime ? mime.startsWith("image/") : isSupportedImageUrl(mediaUrl);
}

export function isVideoStory(item: StoryRailItem): boolean {
  const mediaUrl = item.Media?.url;
  if (item.MediaType !== "video" || !hasUsableMediaUrl(mediaUrl)) return false;
  const mime = item.Media?.mime;
  return mime ? mime.startsWith("video/") : isSupportedVideoUrl(mediaUrl);
}

function getPreviewImageUrl(media?: StoryRailItem["Media"]): string | undefined {
  return (
    media?.formats?.thumbnail?.url ||
    media?.formats?.small?.url ||
    media?.formats?.medium?.url ||
    media?.url
  );
}

export function getStoryRailPreview(
  story: StoryRailStory,
  resolveMediaUrl: ResolveStoryMediaUrl,
): StoryRailPreview {
  const items = getStoryItems(story);
  const first = items[0];
  const thumbnailUrl = getPreviewImageUrl(story.Thumbnail) ?? getPreviewImageUrl(first?.Thumbnail);
  if (thumbnailUrl) {
    return { mode: "image", url: resolveMediaUrl(thumbnailUrl) };
  }

  const imageItem = items.find(isImageStory);
  const mediaUrl = imageItem?.Media?.url;
  if (mediaUrl) {
    return { mode: "image", url: resolveMediaUrl(getPreviewImageUrl(imageItem?.Media) ?? mediaUrl) };
  }

  // A video story with no admin thumbnail: the media worker's generated poster.
  const poster = items.map((item) => (isVideoStory(item) ? readVideoDelivery(item.Media)?.poster : null)).find(Boolean);
  return poster ? { mode: "image", url: resolveMediaUrl(poster) } : { mode: "empty" };
}

export function isStoryFullySeen(
  story: StoryRailStory,
  seenItems?: StorySeenItems,
  legacySeenIds?: ReadonlySet<number>,
): boolean {
  if (!seenItems) return legacySeenIds?.has(story.id) ?? false;
  const seen = seenItems.get(story.id);
  if (!seen) return false;
  return getStoryItems(story).every((item) => seen.has(item.Key));
}

export function firstUnseenItemIndex(story: StoryRailStory | undefined, seenItems?: StorySeenItems): number {
  if (!story) return 0;
  if (!seenItems) return 0;
  const seen = seenItems.get(story.id);
  if (!seen) return 0;
  const index = getStoryItems(story).findIndex((item) => !seen.has(item.Key));
  return index < 0 ? 0 : index;
}
