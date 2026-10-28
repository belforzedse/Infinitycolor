/**
 * Re-points every variation of one product from one colour to another, in place.
 *
 * Colours are shared rows, so a wrong colour picked for a product cannot be fixed
 * by editing the row (that would repaint every other product and past order), and
 * generation is additive, so picking the right colour and generating again only
 * produced empty drafts next to the wrong, published variations. This keeps each
 * variation — price, discount, stock, reservations, publication and its own id —
 * and changes only which colour it points at.
 */
import { deleteVariationWithStock } from "../../product-variation/services/variation-removal";
import { clearProductOriginCaches } from "../../../utils/productOriginCache";
import {
  PRODUCT_VARIATIONS_LOCK_KEY,
  generatedSku,
  loadProductVariationsWithSignatures,
  signatureFromVariation,
  type VariationWithSignature,
} from "./variation-combinations";

const COLOR_UID = "api::product-variation-color.product-variation-color";
const VARIATION_UID = "api::product-variation.product-variation";
const ORDER_ITEM_UID = "api::order-item.order-item";
const HEX_SIX = /^#[0-9a-f]{6}$/;

export class ColorReplaceError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly status: 400 | 403 | 404 | 409,
    message: string,
    public readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ColorReplaceError";
  }
}

export type ColorReplaceInput = {
  productId: unknown;
  fromColorId: unknown;
  toColorId?: unknown;
  newColor?: { title?: unknown; colorCode?: unknown } | null;
  removeEmptyDrafts?: boolean;
  dryRun?: boolean;
  canDeleteVariations?: boolean;
};

export type VariationSummary = {
  id: number;
  label: string;
  sku: string | null;
  isPublished: boolean;
};

export type ColorConflict = VariationSummary & {
  /** The variation that would move onto this one's combination. */
  movingId: number;
  reason: "occupied" | "duplicate";
};

export type ColorReplaceResult = {
  productId: number;
  dryRun: boolean;
  fromColor: { id: number; title: string | null };
  targetColor: {
    /** Null only on a dry run for a colour that does not exist yet. */
    id: number | null;
    title: string;
    colorCode: string | null;
    /** True when this request created the colour (or would, on a dry run). */
    created: boolean;
  };
  moving: VariationSummary[];
  /** Empty drafts that already hold a target combination; removed on apply. */
  emptyDrafts: VariationSummary[];
  /** Real variations in the way; apply refuses while any exist. */
  blocking: ColorConflict[];
};

const asPositiveId = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const invalid = (message: string, errorCode = "COLOR_REPLACE_INVALID") =>
  new ColorReplaceError(errorCode, 400, message);

/** Same rule as the admin colour form: a 6-digit hex, lowercased, or none. */
export function normalizeNewColor(raw: ColorReplaceInput["newColor"]) {
  const title = String(raw?.title ?? "").trim();
  if (!title) throw invalid("نام رنگ را وارد کنید.");
  if (title.length > 255) throw invalid("نام رنگ بیش از حد طولانی است.");

  const rawCode = raw?.colorCode;
  if (rawCode === null || rawCode === undefined || String(rawCode).trim() === "") {
    return { title, colorCode: null as string | null };
  }
  const trimmed = String(rawCode).trim();
  const colorCode = (trimmed.startsWith("#") ? trimmed : `#${trimmed}`).toLowerCase();
  if (!HEX_SIX.test(colorCode)) {
    throw invalid("کد رنگ باید ۶ رقمی و مانند ‎#1E40AF باشد.");
  }
  return { title, colorCode: colorCode as string | null };
}

const titleOf = (value: any): string | null => {
  const title = value?.Title ?? value?.attributes?.Title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
};

/** What an operator recognises a variation by once its colour is set aside. */
function describe(entry: VariationWithSignature): VariationSummary {
  const variation = entry.variation || {};
  const terms = Array.isArray(variation.selected_attribute_terms)
    ? variation.selected_attribute_terms
    : [];
  const parts = [
    titleOf(variation.product_variation_size),
    titleOf(variation.product_variation_model),
    ...terms.map(titleOf),
  ].filter((part): part is string => Boolean(part));

  return {
    id: entry.id,
    label: parts.join(" / ") || `#${entry.id}`,
    sku: entry.SKU ?? null,
    isPublished: Boolean(entry.IsPublished),
  };
}

/**
 * A draft nobody has put anything into: never published, no price, no stock, no
 * reservation and never ordered. That is exactly what generating the right
 * colour next to the wrong one leaves behind, so it is safe to drop in favour of
 * the variation that already carries the real price and stock.
 */
async function isEmptyDraft(strapi: any, entry: VariationWithSignature): Promise<boolean> {
  if (entry.IsPublished) return false;
  if (Number(entry.variation?.Price || 0) > 0) return false;

  const withStock = await strapi.db.query(VARIATION_UID).findOne({
    where: { id: entry.id },
    populate: ["product_stock"],
  });
  const stock = withStock?.product_stock;
  if (Number(stock?.Count || 0) > 0 || Number(stock?.reservedCount || 0) > 0) return false;

  const orderItems = await strapi.db.query(ORDER_ITEM_UID).count({
    where: { product_variation: { id: entry.id } },
  });
  return Number(orderItems || 0) === 0;
}

export async function replaceProductVariationColor(
  strapi: any,
  input: ColorReplaceInput,
): Promise<ColorReplaceResult> {
  const productId = asPositiveId(input.productId);
  if (!productId) throw invalid("شناسه محصول نامعتبر است.");
  const fromColorId = asPositiveId(input.fromColorId);
  if (!fromColorId) throw invalid("رنگ فعلی مشخص نشده است.");

  const toColorId = input.toColorId === undefined || input.toColorId === null
    ? null
    : asPositiveId(input.toColorId);
  if (input.toColorId !== undefined && input.toColorId !== null && !toColorId) {
    throw invalid("رنگ جدید نامعتبر است.");
  }
  if (!toColorId && !input.newColor) throw invalid("رنگ جدید را انتخاب کنید.");
  if (toColorId && input.newColor) throw invalid("فقط یکی از رنگ موجود یا رنگ جدید را بفرستید.");
  const newColor = toColorId ? null : normalizeNewColor(input.newColor);
  const dryRun = input.dryRun === true;

  const outcome = await strapi.db.transaction(async ({ trx }: { trx: any }) => {
    // The same lock generation takes, so the signature set cannot change under us.
    await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [PRODUCT_VARIATIONS_LOCK_KEY, productId]);

    const product = await strapi.db.query("api::product.product").findOne({
      where: { id: productId },
      select: ["id", "Slug"],
    });
    if (!product) throw new ColorReplaceError("PRODUCT_NOT_FOUND", 404, "محصول پیدا نشد.");

    const variations = await loadProductVariationsWithSignatures(strapi, productId);
    const moving = variations.filter((entry) => entry.colorId === fromColorId);
    if (moving.length === 0) {
      throw new ColorReplaceError(
        "COLOR_NOT_ON_PRODUCT",
        404,
        "هیچ تنوعی از این محصول با این رنگ وجود ندارد.",
      );
    }
    const fromColor = {
      id: fromColorId,
      title: titleOf(moving[0].variation?.product_variation_color),
    };

    // Resolve the target without writing yet. A new colour reuses an identical
    // row when one exists rather than adding another duplicate «سفید».
    let target: { id: number | null; title: string; colorCode: string | null; created: boolean };
    if (toColorId) {
      const row = await strapi.db.query(COLOR_UID).findOne({
        where: { id: toColorId },
        select: ["id", "Title", "ColorCode"],
      });
      if (!row) throw new ColorReplaceError("COLOR_NOT_FOUND", 404, "رنگ انتخاب‌شده پیدا نشد.");
      target = { id: row.id, title: row.Title, colorCode: row.ColorCode ?? null, created: false };
    } else {
      const matches = await strapi.db.query(COLOR_UID).findMany({
        where: {
          Title: newColor!.title,
          ColorCode: newColor!.colorCode === null ? { $null: true } : { $eqi: newColor!.colorCode },
        },
        select: ["id", "Title", "ColorCode"],
        orderBy: { id: "asc" },
        limit: 1,
      });
      const match = matches?.[0];
      target = match
        ? { id: match.id, title: match.Title, colorCode: match.ColorCode ?? null, created: false }
        : { id: null, title: newColor!.title, colorCode: newColor!.colorCode, created: true };
    }
    if (target.id === fromColorId) {
      throw new ColorReplaceError("SAME_COLOR", 400, "رنگ جدید با رنگ فعلی یکسان است.");
    }

    // Where each moving variation lands, and what is already there. A colour that
    // does not exist yet cannot be occupied, so it has no conflicts to find.
    const movingIds = new Set(moving.map((entry) => entry.id));
    const occupants = new Map<string, VariationWithSignature>();
    for (const entry of variations) {
      if (!movingIds.has(entry.id) && entry.signature) occupants.set(entry.signature, entry);
    }

    const nextSignature = (entry: VariationWithSignature, colorId: number) =>
      signatureFromVariation({
        ...entry.variation,
        product_variation_color: { id: colorId },
      });

    const emptyDrafts: VariationSummary[] = [];
    const blocking: ColorConflict[] = [];
    if (target.id) {
      const landed = new Map<string, number>();
      for (const entry of moving) {
        const signature = nextSignature(entry, target.id);
        const twin = landed.get(signature);
        if (twin) {
          // Two variations that were already duplicates would stay duplicates.
          blocking.push({ ...describe(entry), movingId: twin, reason: "duplicate" });
          continue;
        }
        landed.set(signature, entry.id);

        const occupant = occupants.get(signature);
        if (!occupant) continue;
        if (await isEmptyDraft(strapi, occupant)) {
          emptyDrafts.push(describe(occupant));
        } else {
          blocking.push({ ...describe(occupant), movingId: entry.id, reason: "occupied" });
        }
      }
    }

    const summary = {
      productId,
      productSlug: typeof product.Slug === "string" ? product.Slug : null,
      fromColor,
      target,
      moving: moving.map(describe),
      emptyDrafts,
      blocking,
    };
    if (dryRun) return summary;

    if (blocking.length > 0) {
      throw new ColorReplaceError(
        "COLOR_REPLACE_CONFLICT",
        409,
        "این محصول از قبل تنوع فعالی با رنگ جدید دارد؛ ابتدا آن را حذف یا ویرایش کنید.",
        { conflicts: blocking },
      );
    }
    if (emptyDrafts.length > 0) {
      if (!input.removeEmptyDrafts) {
        throw new ColorReplaceError(
          "COLOR_REPLACE_DRAFTS_PENDING",
          409,
          "تنوع‌های پیش‌نویس خالی با رنگ جدید وجود دارند و باید حذف شوند.",
          { drafts: emptyDrafts },
        );
      }
      if (!input.canDeleteVariations) {
        throw new ColorReplaceError(
          "VARIATION_DELETE_FORBIDDEN",
          403,
          "شما مجوز حذف تنوع محصول را ندارید.",
        );
      }
      for (const draft of emptyDrafts) {
        await deleteVariationWithStock(strapi, draft.id, trx);
      }
    }

    if (!target.id) {
      const created = await strapi.entityService.create(COLOR_UID, {
        data: { Title: target.title, ColorCode: target.colorCode },
      });
      target = { ...target, id: Number(created.id) };
    }

    for (const entry of moving) {
      const signature = nextSignature(entry, target.id!);
      const data: Record<string, unknown> = {
        product_variation_color: target.id,
        AttributeSignature: signature,
      };
      // A generated SKU encodes the old signature. Left in place it would collide
      // with the SKU a later generation of the old colour computes.
      if (entry.SKU && entry.SKU === generatedSku(productId, entry.signature)) {
        data.SKU = generatedSku(productId, signature);
      }
      // entityService so the variation lifecycles still audit the colour change.
      await strapi.entityService.update(VARIATION_UID, entry.id, { data });
    }

    return { ...summary, target };
  });

  if (!dryRun && outcome.productSlug) {
    // After commit: invalidating first would let the storefront re-cache the old
    // colour from a read that still saw the uncommitted state.
    await clearProductOriginCaches(strapi, outcome.productSlug, {
      availabilityCrossed: true,
      logPrefix: "variation-color-replace",
    });
  }

  return {
    productId: outcome.productId,
    dryRun,
    fromColor: outcome.fromColor,
    targetColor: outcome.target,
    moving: outcome.moving,
    emptyDrafts: outcome.emptyDrafts,
    blocking: outcome.blocking,
  };
}
