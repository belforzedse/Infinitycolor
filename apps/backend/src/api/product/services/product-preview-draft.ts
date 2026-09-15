/**
 * Ephemeral admin product-preview drafts.
 *
 * An admin editing a product wants to see it rendered exactly like the
 * storefront PDP, including edits not yet saved to the product row. Rather
 * than persisting a draft snapshot to the database, the overlay (the subset
 * of edited fields) is stashed in Redis behind a short-lived opaque token —
 * the same bearer-token idiom already used for OTP/credential challenges
 * (see api/auth/services/credential-flow.ts) — and merged onto the live
 * product on read. Nothing here ever touches the real product row.
 */
import crypto from "node:crypto";
import { RedisClient } from "../../..";

const PREVIEW_DRAFT_TTL_SECONDS = 30 * 60;
const PREVIEW_DRAFT_KEY_PREFIX = "product-preview-draft:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export interface ProductPreviewOverlay {
  Title?: string;
  Description?: string;
  Status?: "Active" | "InActive" | "Scheduled";
  coverImageId?: number | null;
  mediaIds?: number[];
  fileIds?: number[];
  mainCategoryId?: number | null;
  otherCategoryIds?: number[];
  tagIds?: number[];
  /** Ties Simple-product price/stock edits to the one variation they actually live on. */
  simpleVariationId?: number;
  simplePrice?: number;
  simpleDiscountPrice?: number | null;
  simpleStock?: number;
}

export interface StoredProductPreviewDraft {
  productId: number;
  overlay: ProductPreviewOverlay;
  createdBy?: number;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sanitizeIdArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter(isPositiveInt);
  return ids;
}

/**
 * Only known fields, only plausible types. The overlay is untrusted request
 * input that gets echoed back into a rendered page, so nothing here is
 * carried through verbatim.
 */
export function sanitizeProductPreviewOverlay(input: unknown): ProductPreviewOverlay {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const overlay: ProductPreviewOverlay = {};

  if (typeof raw.Title === "string") overlay.Title = raw.Title.slice(0, 500);
  if (typeof raw.Description === "string") overlay.Description = raw.Description.slice(0, 20000);
  if (raw.Status === "Active" || raw.Status === "InActive" || raw.Status === "Scheduled") {
    overlay.Status = raw.Status;
  }

  if (raw.coverImageId === null || isPositiveInt(raw.coverImageId)) {
    overlay.coverImageId = raw.coverImageId as number | null;
  }
  const mediaIds = sanitizeIdArray(raw.mediaIds);
  if (mediaIds) overlay.mediaIds = mediaIds;
  const fileIds = sanitizeIdArray(raw.fileIds);
  if (fileIds) overlay.fileIds = fileIds;

  if (raw.mainCategoryId === null || isPositiveInt(raw.mainCategoryId)) {
    overlay.mainCategoryId = raw.mainCategoryId as number | null;
  }
  const otherCategoryIds = sanitizeIdArray(raw.otherCategoryIds);
  if (otherCategoryIds) overlay.otherCategoryIds = otherCategoryIds;
  const tagIds = sanitizeIdArray(raw.tagIds);
  if (tagIds) overlay.tagIds = tagIds;

  if (isPositiveInt(raw.simpleVariationId)) overlay.simpleVariationId = raw.simpleVariationId;
  if (typeof raw.simplePrice === "number" && raw.simplePrice >= 0) overlay.simplePrice = raw.simplePrice;
  if (raw.simpleDiscountPrice === null || (typeof raw.simpleDiscountPrice === "number" && raw.simpleDiscountPrice >= 0)) {
    overlay.simpleDiscountPrice = raw.simpleDiscountPrice as number | null;
  }
  if (typeof raw.simpleStock === "number" && raw.simpleStock >= 0) overlay.simpleStock = raw.simpleStock;

  return overlay;
}

export async function createProductPreviewDraft(
  productId: number,
  overlay: ProductPreviewOverlay,
  createdBy?: number,
): Promise<string> {
  const token = crypto.randomBytes(24).toString("base64url");
  const redis = await RedisClient;
  const stored = await redis.set(
    PREVIEW_DRAFT_KEY_PREFIX + token,
    JSON.stringify({ productId, overlay, createdBy } satisfies StoredProductPreviewDraft),
    { EX: PREVIEW_DRAFT_TTL_SECONDS, NX: true },
  );
  if (stored !== "OK") {
    throw new Error("Failed to store product preview draft");
  }
  return token;
}

export async function readProductPreviewDraft(
  token: string,
): Promise<StoredProductPreviewDraft | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;

  const redis = await RedisClient;
  const raw = await redis.get(PREVIEW_DRAFT_KEY_PREFIX + token);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredProductPreviewDraft;
    if (!isPositiveInt(parsed?.productId)) return null;
    return parsed;
  } catch {
    return null;
  }
}
