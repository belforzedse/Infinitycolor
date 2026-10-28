import { randomUUID } from "node:crypto";
import { applyStoryCtaMutation, normalizeStoryCtaUrl } from "./story-cta";

export const STORY_ITEM_LIMIT = 20;
export const DEFAULT_STORY_DURATION_MS = 5000;

export type StoryMediaType = "image" | "video";

type UploadFile = {
  id: number;
  mime?: string | null;
  name?: string | null;
  url?: string | null;
};

export type StoryItemRecord = {
  id?: number;
  Key: string;
  MediaType: StoryMediaType;
  Media: number | UploadFile | Record<string, unknown>;
  Thumbnail?: number | UploadFile | Record<string, unknown> | null;
  DurationMs: number;
  CtaLabel?: string | null;
  CtaUrl?: string | null;
  Overlays?: unknown;
};

export class StoryItemsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryItemsValidationError";
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function extractRelationId(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (Array.isArray(value)) return value.length ? extractRelationId(value[0]) : null;
  if (typeof value !== "object") return undefined;

  const relation = value as {
    id?: unknown;
    data?: unknown;
    connect?: unknown[];
    set?: unknown[];
    disconnect?: unknown[];
  };
  if (relation.id !== undefined) return extractRelationId(relation.id);
  if (relation.data !== undefined) return extractRelationId(relation.data);
  if (Array.isArray(relation.connect) && relation.connect.length) {
    return extractRelationId(relation.connect[0]);
  }
  if (Array.isArray(relation.set)) {
    return relation.set.length ? extractRelationId(relation.set[0]) : null;
  }
  if (Array.isArray(relation.disconnect)) return null;
  return undefined;
}

export function legacyStoryItemKey(storyId: number): string {
  return `legacy:${storyId}`;
}

export function newStoryItemKey(): string {
  return `item:${randomUUID()}`;
}

function validateKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return newStoryItemKey();
  const key = value.trim();
  if (key.length > 64 || !/^[\p{L}\p{N}._:-]+$/u.test(key)) {
    throw new StoryItemsValidationError("شناسه داخلی یکی از آیتم‌های استوری معتبر نیست.");
  }
  return key;
}

function normalizeDuration(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_STORY_DURATION_MS;
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 1000) {
    throw new StoryItemsValidationError("مدت نمایش هر آیتم باید حداقل یک ثانیه باشد.");
  }
  return duration;
}

function boundedNumber(value: unknown, label: string, min: number, max: number, fallback?: number): number | undefined {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new StoryItemsValidationError(`${label} معتبر نیست.`);
  }
  return number;
}

function normalizeOverlays(value: unknown, itemIndex: number): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 12) {
    throw new StoryItemsValidationError(`لایه‌های آیتم ${itemIndex + 1} معتبر نیست.`);
  }
  return value.map((entry, overlayIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new StoryItemsValidationError(`لایه ${overlayIndex + 1} آیتم ${itemIndex + 1} معتبر نیست.`);
    }
    const overlay = entry as Record<string, unknown>;
    const type = overlay.type;
    if (type !== "text" && type !== "sticker" && type !== "shape") {
      throw new StoryItemsValidationError(`نوع لایه ${overlayIndex + 1} آیتم ${itemIndex + 1} معتبر نیست.`);
    }
    const id = validateKey(overlay.id);
    const content = typeof overlay.content === "string" ? overlay.content.trim() : "";
    const imageUrl = type === "sticker" ? normalizeStoryCtaUrl(overlay.imageUrl) : null;
    if (type === "text" && (!content || content.length > 300)) {
      throw new StoryItemsValidationError(`متن لایه ${overlayIndex + 1} آیتم ${itemIndex + 1} معتبر نیست.`);
    }
    if (type === "sticker" && !imageUrl) {
      throw new StoryItemsValidationError(`تصویر لایه ${overlayIndex + 1} آیتم ${itemIndex + 1} الزامی است.`);
    }
    const fontColor = typeof overlay.fontColor === "string" && /^#[0-9a-f]{6}$/i.test(overlay.fontColor)
      ? overlay.fontColor
      : "#ffffff";
    const fontFamily = typeof overlay.fontFamily === "string" && overlay.fontFamily.length <= 80
      ? overlay.fontFamily
      : undefined;
    return {
      id,
      type,
      x: boundedNumber(overlay.x, "موقعیت افقی لایه", 0, 100, 50),
      y: boundedNumber(overlay.y, "موقعیت عمودی لایه", 0, 100, 50),
      width: boundedNumber(overlay.width, "عرض لایه", 1, 100),
      height: boundedNumber(overlay.height, "ارتفاع لایه", 1, 100),
      rotation: boundedNumber(overlay.rotation, "چرخش لایه", -360, 360, 0),
      content: type === "text" ? content : undefined,
      fontSize: type === "text" ? boundedNumber(overlay.fontSize, "اندازه متن", 8, 96, 28) : undefined,
      fontColor,
      fontFamily,
      imageUrl: imageUrl ?? undefined,
    };
  });
}

async function getUploadFile(strapi: any, id: number): Promise<UploadFile | null> {
  return (await strapi.entityService.findOne("plugin::upload.file", id, {
    fields: ["id", "mime", "name", "url"],
  })) as UploadFile | null;
}

async function validateMedia(
  strapi: any,
  mediaType: StoryMediaType,
  mediaId: number,
  thumbnailId?: number | null,
): Promise<void> {
  const media = await getUploadFile(strapi, mediaId);
  if (!media) throw new StoryItemsValidationError("رسانه یکی از آیتم‌های استوری یافت نشد.");
  const mime = String(media.mime ?? "");
  if (mediaType === "video" && !mime.startsWith("video/")) {
    throw new StoryItemsValidationError("برای آیتم ویدیویی باید فایل ویدیو انتخاب شود.");
  }
  if (mediaType === "image" && !mime.startsWith("image/")) {
    throw new StoryItemsValidationError("برای آیتم تصویری باید فایل تصویر انتخاب شود.");
  }
  if (thumbnailId) {
    const thumbnail = await getUploadFile(strapi, thumbnailId);
    if (!thumbnail || !String(thumbnail.mime ?? "").startsWith("image/")) {
      throw new StoryItemsValidationError("تصویر پیش‌نمایش یکی از آیتم‌ها معتبر نیست.");
    }
  }
}

function mergeItem(raw: Record<string, unknown>, existing?: Record<string, unknown>) {
  return existing ? { ...existing, ...raw } : raw;
}

async function normalizeItems(
  strapi: any,
  rawItems: unknown[],
  existingItems: Array<Record<string, unknown>>,
): Promise<StoryItemRecord[]> {
  if (rawItems.length < 1 || rawItems.length > STORY_ITEM_LIMIT) {
    throw new StoryItemsValidationError("هر استوری باید بین ۱ تا ۲۰ آیتم داشته باشد.");
  }

  const normalized = await Promise.all(
    rawItems.map(async (value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new StoryItemsValidationError(`اطلاعات آیتم ${index + 1} معتبر نیست.`);
      }
      const raw = value as Record<string, unknown>;
      const rawId = Number(raw.id);
      const existing = existingItems.find(
        (item) =>
          (Number.isFinite(rawId) && Number(item.id) === rawId) ||
          (typeof raw.Key === "string" && item.Key === raw.Key),
      );
      const merged = mergeItem(raw, existing);
      const mediaType = merged.MediaType;
      if (mediaType !== "image" && mediaType !== "video") {
        throw new StoryItemsValidationError(`نوع رسانه آیتم ${index + 1} معتبر نیست.`);
      }
      const mediaId = extractRelationId(merged.Media);
      if (!mediaId) {
        throw new StoryItemsValidationError(`رسانه آیتم ${index + 1} الزامی است.`);
      }
      const thumbnailId = extractRelationId(merged.Thumbnail);
      const key = existing?.Key ? String(existing.Key) : validateKey(merged.Key);
      const cta = {
        CtaUrl: hasOwn(merged, "CtaUrl") ? merged.CtaUrl : null,
        CtaLabel: merged.CtaLabel,
      };
      applyStoryCtaMutation(cta);
      await validateMedia(strapi, mediaType, mediaId, thumbnailId);

      return {
        ...(existing?.id ? { id: Number(existing.id) } : {}),
        Key: key,
        MediaType: mediaType,
        Media: mediaId,
        Thumbnail: thumbnailId ?? null,
        DurationMs: normalizeDuration(merged.DurationMs),
        CtaLabel: cta.CtaLabel as string | null,
        CtaUrl: cta.CtaUrl as string | null,
        Overlays: normalizeOverlays(merged.Overlays, index),
      } satisfies StoryItemRecord;
    }),
  );

  const keys = new Set<string>();
  for (const item of normalized) {
    if (keys.has(item.Key)) {
      throw new StoryItemsValidationError("شناسه آیتم‌های استوری باید یکتا باشد.");
    }
    keys.add(item.Key);
  }
  return normalized;
}

const LEGACY_ITEM_FIELDS = [
  "MediaType",
  "Media",
  "DurationMs",
  "CtaUrl",
  "CtaLabel",
  "Overlays",
] as const;

function legacyItemFromStory(story: Record<string, unknown>, key?: string): Record<string, unknown> {
  return {
    Key: key ?? newStoryItemKey(),
    MediaType: story.MediaType ?? "image",
    Media: story.Media,
    // The old thumbnail was both rail cover and video poster. Keep it as the item poster
    // during migration while leaving the story-level relation intact for the rail.
    Thumbnail: story.Thumbnail ?? null,
    DurationMs: story.DurationMs ?? DEFAULT_STORY_DURATION_MS,
    CtaUrl: story.CtaUrl ?? null,
    CtaLabel: story.CtaLabel ?? null,
    Overlays: story.Overlays ?? [],
  };
}

async function loadExistingStory(strapi: any, storyId: number): Promise<Record<string, unknown> | null> {
  return (await strapi.entityService.findOne("api::story.story", storyId, {
    populate: {
      Media: { fields: ["id", "mime", "url"] },
      Thumbnail: { fields: ["id", "mime", "url"] },
      Items: {
        populate: {
          Media: { fields: ["id", "mime", "url"] },
          Thumbnail: { fields: ["id", "mime", "url"] },
        },
      },
    },
  })) as Record<string, unknown> | null;
}

/**
 * Mutates Strapi create/update data into the canonical Items contract and mirrors Items[0]
 * into the one-release legacy fields. Safe to invoke from both controllers and lifecycles.
 */
export async function prepareStoryMutation(
  strapi: any,
  data: Record<string, unknown>,
  storyId?: number,
): Promise<void> {
  const hasItems = hasOwn(data, "Items");
  const hasLegacyMutation = LEGACY_ITEM_FIELDS.some((field) => hasOwn(data, field));
  if (!hasItems && !hasLegacyMutation && storyId) return;

  const existing = storyId ? await loadExistingStory(strapi, storyId) : null;
  const existingItems = Array.isArray(existing?.Items)
    ? (existing.Items as Array<Record<string, unknown>>)
    : [];

  let rawItems: unknown[];
  if (hasItems) {
    if (!Array.isArray(data.Items)) {
      throw new StoryItemsValidationError("فهرست آیتم‌های استوری معتبر نیست.");
    }
    rawItems = data.Items;
  } else if (existingItems.length) {
    const first = { ...existingItems[0] };
    for (const field of LEGACY_ITEM_FIELDS) {
      if (hasOwn(data, field)) first[field] = data[field];
    }
    rawItems = [first, ...existingItems.slice(1)];
  } else {
    const source = { ...(existing ?? {}), ...data };
    const migrationKey = storyId ? legacyStoryItemKey(storyId) : undefined;
    rawItems = [legacyItemFromStory(source, migrationKey)];
  }

  const items = await normalizeItems(strapi, rawItems, existingItems);
  data.Items = items;

  const first = items[0];
  data.MediaType = first.MediaType;
  data.Media = extractRelationId(first.Media);
  data.DurationMs = first.DurationMs;
  data.CtaUrl = first.CtaUrl ?? null;
  data.CtaLabel = first.CtaLabel ?? null;
  data.Overlays = first.Overlays ?? [];
}

export function storyItemKeys(story: { id: number; Items?: Array<{ Key?: string }> }): string[] {
  const keys = (story.Items ?? [])
    .map((item) => item?.Key)
    .filter((key): key is string => typeof key === "string" && key.length > 0);
  return keys.length ? keys : [legacyStoryItemKey(story.id)];
}
