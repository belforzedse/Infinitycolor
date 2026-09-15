import type { ResolveStoryMediaUrl, StoryRailPreview, StoryRailStory } from "./types";

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

export function isImageStory(story: StoryRailStory): boolean {
  const mediaUrl = story.Media?.url;
  if (story.MediaType !== "image" || !hasUsableMediaUrl(mediaUrl)) return false;
  const mime = story.Media?.mime;
  return mime ? mime.startsWith("image/") : isSupportedImageUrl(mediaUrl);
}

export function isVideoStory(story: StoryRailStory): boolean {
  const mediaUrl = story.Media?.url;
  if (story.MediaType !== "video" || !hasUsableMediaUrl(mediaUrl)) return false;
  const mime = story.Media?.mime;
  return mime ? mime.startsWith("video/") : isSupportedVideoUrl(mediaUrl);
}

function getPreviewImageUrl(media?: StoryRailStory["Media"]): string | undefined {
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
  const thumbnailUrl = getPreviewImageUrl(story.Thumbnail);
  if (thumbnailUrl) {
    return { mode: "image", url: resolveMediaUrl(thumbnailUrl) };
  }

  const mediaUrl = story.Media?.url;
  if (!mediaUrl) return { mode: "empty" };

  if (story.MediaType === "video" && isVideoStory(story)) {
    return { mode: "empty" };
  }

  if (story.MediaType === "image" && isImageStory(story)) {
    return {
      mode: "image",
      url: resolveMediaUrl(getPreviewImageUrl(story.Media) ?? mediaUrl),
    };
  }

  return { mode: "empty" };
}
