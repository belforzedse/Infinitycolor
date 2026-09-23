import type { Story, StoryItem, StoryMediaAsset, StoryMediaType, StoryOverlay } from "./types/story";

function unwrapEntity(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return unwrapEntity(record.data);
  }
  const attributes = record.attributes;
  if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
    return { id: record.id, ...(attributes as Record<string, unknown>) };
  }
  return record;
}

function unwrapArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: unknown[] }).data;
  }
  return [];
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mediaType(value: unknown): StoryMediaType {
  return value === "video" ? "video" : "image";
}

export function normalizeStoryMediaAsset(raw: unknown): StoryMediaAsset | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return { id: raw, url: "" };
  if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) {
    return { id: Number(raw), url: "" };
  }
  const entity = unwrapEntity(raw);
  if (!entity) return undefined;
  const id = Number(entity.id);
  if (!Number.isFinite(id)) return undefined;
  const formats =
    entity.formats && typeof entity.formats === "object"
      ? (entity.formats as StoryMediaAsset["formats"])
      : undefined;
  const providerMetadata =
    entity.provider_metadata && typeof entity.provider_metadata === "object"
      ? (entity.provider_metadata as { video?: unknown })
      : undefined;
  return {
    id,
    url: stringValue(entity.url),
    alternativeText: optionalString(entity.alternativeText),
    width: typeof entity.width === "number" ? entity.width : undefined,
    height: typeof entity.height === "number" ? entity.height : undefined,
    mime: optionalString(entity.mime),
    formats,
    previewUrl: optionalString(entity.previewUrl),
    // Keep only the pipeline's delivery record, not whatever else a provider stored.
    ...(providerMetadata?.video ? { provider_metadata: { video: providerMetadata.video } } : {}),
  };
}

export function normalizeStoryItem(raw: unknown, storyId: number, index: number): StoryItem | null {
  const entity = unwrapEntity(raw);
  if (!entity) return null;
  return {
    id: typeof entity.id === "number" ? entity.id : undefined,
    Key: stringValue(entity.Key, `legacy:${storyId}${index ? `:${index}` : ""}`),
    MediaType: mediaType(entity.MediaType),
    Media: normalizeStoryMediaAsset(entity.Media),
    Thumbnail: normalizeStoryMediaAsset(entity.Thumbnail),
    DurationMs: numberValue(entity.DurationMs, 5000),
    CtaLabel: typeof entity.CtaLabel === "string" ? entity.CtaLabel : null,
    CtaUrl: typeof entity.CtaUrl === "string" ? entity.CtaUrl : null,
    Overlays: Array.isArray(entity.Overlays) ? (entity.Overlays as StoryOverlay[]) : [],
  };
}

export function normalizeStoryEntity(raw: unknown): Story {
  const entity = unwrapEntity(raw);
  if (!entity) throw new Error("Invalid story data");
  const id = numberValue(entity.id);
  const legacyItem: StoryItem = {
    Key: `legacy:${id}`,
    MediaType: mediaType(entity.MediaType),
    Media: normalizeStoryMediaAsset(entity.Media),
    Thumbnail: normalizeStoryMediaAsset(entity.Thumbnail),
    DurationMs: numberValue(entity.DurationMs, 5000),
    CtaLabel: typeof entity.CtaLabel === "string" ? entity.CtaLabel : null,
    CtaUrl: typeof entity.CtaUrl === "string" ? entity.CtaUrl : null,
    Overlays: Array.isArray(entity.Overlays) ? (entity.Overlays as StoryOverlay[]) : [],
  };
  const Items = unwrapArray(entity.Items)
    .map((item, index) => normalizeStoryItem(item, id, index))
    .filter((item): item is StoryItem => item !== null);

  return {
    id,
    Title: stringValue(entity.Title),
    Slug: stringValue(entity.Slug),
    IsActive: Boolean(entity.IsActive),
    SortOrder: numberValue(entity.SortOrder),
    Items: Items.length ? Items : [legacyItem],
    MediaType: legacyItem.MediaType,
    Media: legacyItem.Media,
    Thumbnail: normalizeStoryMediaAsset(entity.Thumbnail),
    StartAt: optionalString(entity.StartAt),
    EndAt: optionalString(entity.EndAt),
    DurationMs: legacyItem.DurationMs,
    CtaLabel: legacyItem.CtaLabel,
    CtaUrl: legacyItem.CtaUrl,
    Overlays: legacyItem.Overlays,
    createdAt: stringValue(entity.createdAt),
    updatedAt: stringValue(entity.updatedAt),
  };
}
