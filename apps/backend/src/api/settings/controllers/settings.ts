// @ts-nocheck
/**
 * settings controller
 */

import { CatalogEditError, runCatalogMutation, sendCatalogEditError, staffEditor, withHomepageSettingsWrite } from "../../../utils/catalogEdit";
import { getFrontendUrls } from "../../../utils/revalidate";
import { clearAllProductCaches } from "../../../utils/productOriginCache";
import type { Attribute } from "@strapi/types";
import { factories } from "@strapi/strapi";
import { writeAuditEvent } from "../../../audit/writer";
import { getAuditContext } from "../../../utils/audit-context";
import {
  createHeroSliderMeta,
  normalizeStoredHeroSliderPayload,
  sanitizeHeroSliderPayload,
} from "../services/hero-slider-schema";
import { sanitizeCustomSectionHref } from "../services/custom-section-href";

/** Sanitized payload is valid JSON; cast for Strapi JSON fields which expect Attribute.JsonValue. */
function toStrapiJson<T>(v: T): Attribute.JsonValue {
  return v as unknown as Attribute.JsonValue;
}

const SETTINGS_UID = "api::settings.settings";
const BLOG_BANNER_FIELDS = [
  "blogCategoryBannerOrder",
  "blogDefaultBannerImage",
  "blogDefaultBannerTitle",
  "blogDefaultBannerSubtitle",
  "blogDefaultBannerTitleColor",
  "blogDefaultBannerSubtitleColor",
  "blogDefaultBannerLinkText",
  "blogDefaultBannerLinkColor",
] as const;

function projectBlogBannerSettings(settings: any) {
  return Object.fromEntries(
    BLOG_BANNER_FIELDS.map((field) => [field, settings?.[field] ?? (field === "blogCategoryBannerOrder" ? [] : "")]),
  );
}

const HOMEPAGE_PRODUCT_ID_FIELDS = [
  "homeNewestProductIds",
  "homeFavoriteProductIds",
  "homeDiscountedProductIds",
  "homeWeeklyPicksProductIds",
  "homeEveryoneFollowsProductIds",
] as const;
const HOMEPAGE_PRODUCT_ENABLED_FIELDS = [
  "homeWeeklyPicksEnabled",
  "homeEveryoneFollowsEnabled",
] as const;
const HOMEPAGE_PRODUCT_FIELDS = [
  ...HOMEPAGE_PRODUCT_ID_FIELDS,
  ...HOMEPAGE_PRODUCT_ENABLED_FIELDS,
] as const;

function projectHomepageProductSettings(settings: any) {
  return { HomepageProductsRevision: Number(settings?.HomepageProductsRevision || 0), ...Object.fromEntries(
    HOMEPAGE_PRODUCT_FIELDS.map((field) => [
      field,
      (HOMEPAGE_PRODUCT_ENABLED_FIELDS as readonly string[]).includes(field)
        ? Boolean(settings?.[field])
        : Array.isArray(settings?.[field])
          ? settings[field]
          : [],
    ]),
  ) };
}

// Newest/Favorite/Discounted arrays now also drive the full "View all" storefront
// listing (see product.ts's findProductCards), not just the 20-item homepage rail, so
// they're no longer implicitly bounded by a display cap. This ceiling matches
// product-card-query.ts's own pagination `limit` cap (100), so the curated-eligibility
// pass there never has to reason about an unbounded list.
const HOMEPAGE_PRODUCT_ID_CAP = 100;

function sanitizeHomepageProductIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > HOMEPAGE_PRODUCT_ID_CAP) return null;
  const result: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const id = Number(item);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function sanitizeWooSourceIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = String(item).trim();
    if (!/^\d+$/.test(id) || id === "0") return null;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

const GIF_PROMO_FIELDS = ["homeGifPromoSlot1Assignment", "homeGifPromoSlot2Assignment"] as const;
const CUSTOM_SECTION_ASSIGNMENT_FIELDS = [
  "homeCustomSectionAssignment",
  "homeCustomSectionTwoAssignment",
  "homeCustomSectionThreeAssignment",
] as const;
const CUSTOM_SECTION_ENABLED_FIELDS = [
  "homeCustomSectionEnabled",
  "homeCustomSectionTwoEnabled",
  "homeCustomSectionThreeEnabled",
] as const;
const CUSTOM_SECTION_TITLE_FIELDS = [
  "homeCustomSectionTitle",
  "homeCustomSectionTwoTitle",
  "homeCustomSectionThreeTitle",
] as const;
const CUSTOM_SECTION_LINK_FIELDS = [
  "homeCustomSectionViewAllHref",
  "homeCustomSectionTwoViewAllHref",
  "homeCustomSectionThreeViewAllHref",
] as const;
const CUSTOM_SECTION_FIELDS = [
  ...CUSTOM_SECTION_ENABLED_FIELDS,
  ...CUSTOM_SECTION_TITLE_FIELDS,
  ...CUSTOM_SECTION_ASSIGNMENT_FIELDS,
  ...CUSTOM_SECTION_LINK_FIELDS,
] as const;

/** Flat booleans/strings for every custom section, matching the assignment projection helper. */
function projectCustomSectionSettings(settings: any) {
  return {
    ...Object.fromEntries(
      CUSTOM_SECTION_ENABLED_FIELDS.map((field) => [field, Boolean(settings?.[field])]),
    ),
    ...Object.fromEntries(
      [...CUSTOM_SECTION_TITLE_FIELDS, ...CUSTOM_SECTION_LINK_FIELDS].map((field) => [
        field,
        typeof settings?.[field] === "string" ? settings[field] : "",
      ]),
    ),
  };
}

function lenientProductIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of value) {
    const id = Number(item);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Same shape/defaults the storefront read path (product service) tolerates. */
function normalizeHomeProductAssignment(value: unknown) {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const mode = input.mode === "category" ? "category" : "manual";
  return {
    mode,
    productIds: lenientProductIds(input.productIds),
    categorySlug: typeof input.categorySlug === "string" ? input.categorySlug.trim() : "",
  };
}

function projectAssignmentFieldSettings(settings: any, fields: readonly string[]) {
  return Object.fromEntries(
    fields.map((field) => [field, normalizeHomeProductAssignment(settings?.[field])]),
  );
}

async function ensureSettingsEntity(strapi: any) {
  const existing = await strapi.db.query(SETTINGS_UID).findOne({ where: {} });
  if (existing) {
    return existing;
  }

  return strapi.entityService.create(SETTINGS_UID, {
    data: {},
  });
}

function extractPayloadFromRequestBody(body: any) {
  if (body && typeof body === "object" && body.data !== undefined) {
    return body.data;
  }
  return body;
}

function settingChanges(before: any, after: any, fields: readonly string[]) {
  return fields
    .filter((field) => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null))
    .map((field) => ({
      field,
      from: before?.[field] ?? null,
      to: after?.[field] ?? null,
    }));
}

function heroSliderSnapshot(payload: any) {
  const normalized = normalizeStoredHeroSliderPayload(payload);
  return {
    version: normalized.version,
    slideCount: normalized.slides.length,
    activeSlideCount: normalized.slides.filter((slide: any) => slide.isActive !== false).length,
    scheduledSlideCount: normalized.slides.filter(
      (slide: any) => slide.schedule?.startAtUtc || slide.schedule?.endAtUtc,
    ).length,
  };
}

function settingsDedupeKey(operation: string, settingsId: number | string) {
  const requestId = getAuditContext()?.requestId;
  return requestId ? `settings:${operation}:${settingsId}:${requestId}` : null;
}

/** Trigger Next.js on-demand revalidation for hero slider (home page). */
async function triggerHeroSliderRevalidation(strapi: { log: { warn: (msg: string) => void; error: (msg: string, ...args: unknown[]) => void; info: (msg: string) => void } }) {
  const frontendUrls = getFrontendUrls();

  if (frontendUrls.length === 0) {
    strapi.log.warn("[Settings] No NEXTJS_REVALIDATION_URL or fallback URLs configured");
    return;
  }

  const revalidationSecret = process.env.REVALIDATION_SECRET;
  if (!revalidationSecret) {
    strapi.log.warn("[Settings] REVALIDATION_SECRET not set, skipping hero-slider revalidation");
    return;
  }

  const revalidationPromises = frontendUrls.map(async (frontendUrl) => {
    try {
      const url = `${frontendUrl.replace(/\/$/, "")}/api/revalidate`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${revalidationSecret}`,
        },
        body: JSON.stringify({ type: "hero-slider" }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        strapi.log.error(
          `[Settings] Hero-slider revalidation failed for ${frontendUrl}: ${response.status} ${errorText}`,
        );
        return { url: frontendUrl, success: false };
      }

      strapi.log.info(`[Settings] Hero-slider revalidation triggered for ${frontendUrl}`);
      return { url: frontendUrl, success: true };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        strapi.log.warn(`[Settings] Hero-slider revalidation timeout for ${frontendUrl}`);
      } else {
        strapi.log.error(`[Settings] Error triggering hero-slider revalidation for ${frontendUrl}:`, error);
      }
      return { url: frontendUrl, success: false };
    }
  });

  const results = await Promise.allSettled(revalidationPromises);
  const successful = results.filter(
    (r): r is PromiseFulfilledResult<{ url: string; success: boolean }> =>
      r.status === "fulfilled" && r.value?.success,
  ).length;
  strapi.log.info(`[Settings] Hero-slider revalidation completed: ${successful}/${frontendUrls.length} successful`);
}

export default factories.createCoreController(SETTINGS_UID, ({ strapi }) => ({
  async create(ctx) {
    if ([...HOMEPAGE_PRODUCT_FIELDS, "HomepageProductsRevision"].some((field) => field in (ctx.request?.body?.data || {}))) return ctx.badRequest("Use the homepage products operation");
    return super.create(ctx);
  },
  async update(ctx) {
    if ([...HOMEPAGE_PRODUCT_FIELDS, "HomepageProductsRevision"].some((field) => field in (ctx.request?.body?.data || {}))) return ctx.badRequest("Use the homepage products operation");
    return super.update(ctx);
  },

  async getBlogBanners(ctx) {
    const settingsEntity = await ensureSettingsEntity(strapi);
    ctx.body = {
      data: {
        id: settingsEntity.id,
        attributes: projectBlogBannerSettings(settingsEntity),
      },
    };
  },

  async updateBlogBanners(ctx) {
    const payload = extractPayloadFromRequestBody(ctx.request.body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return ctx.badRequest("Blog banner payload must be an object");
    }
    const allowed = new Set<string>(BLOG_BANNER_FIELDS);
    const rejectedFields = Object.keys(payload).filter((field) => !allowed.has(field));
    if (rejectedFields.length > 0) {
      return ctx.badRequest("Blog banner payload contains protected settings fields", {
        fields: rejectedFields.sort(),
      });
    }
    const data: Record<string, unknown> = {};
    for (const field of BLOG_BANNER_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      const value = payload[field];
      if (field === "blogCategoryBannerOrder") {
        if (!Array.isArray(value)) return ctx.badRequest("Blog category banner order must be an array");
        data[field] = value;
      } else {
        if (typeof value !== "string") return ctx.badRequest(`${field} must be a string`);
        data[field] = value.trim();
      }
    }
    const settingsEntity = await ensureSettingsEntity(strapi);
    const updated = await strapi.db.transaction(async ({ trx }) => {
      const entity = await strapi.entityService.update(SETTINGS_UID, settingsEntity.id, {
        data,
        transacting: trx,
      });
      const changes = settingChanges(settingsEntity, entity, Object.keys(data));
      await writeAuditEvent(
        strapi,
        {
          eventKey: "content.changed",
          result: changes.length > 0 ? "success" : "no_op",
          target: { type: "settings", id: settingsEntity.id, label: "بنرهای وبلاگ" },
          changes,
          summaryFa:
            changes.length > 0 ? "تنظیمات بنرهای وبلاگ تغییر کرد" : "تنظیمات بنرهای وبلاگ تغییری نکرد",
          summaryEn:
            changes.length > 0 ? "Blog banner settings changed" : "Blog banner settings did not change",
          metadata: { section: "blog_banners", changedFieldCount: changes.length },
          dedupeKey: settingsDedupeKey("blog-banners", settingsEntity.id),
        },
        { trx },
      );
      return entity;
    });
    ctx.body = {
      data: {
        id: updated.id,
        attributes: projectBlogBannerSettings(updated),
      },
    };
  },

  async getHomepageProducts(ctx) {
    const settingsEntity = await ensureSettingsEntity(strapi);
    ctx.body = {
      data: {
        id: settingsEntity.id,
        attributes: projectHomepageProductSettings(settingsEntity),
      },
    };
  },

  async updateHomepageProducts(ctx) {
    const payload = extractPayloadFromRequestBody(ctx.request.body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return ctx.badRequest("Homepage product payload must be an object");
    }
    const allowed = new Set<string>(HOMEPAGE_PRODUCT_FIELDS);
    const rejectedFields = Object.keys(payload).filter((field) => !allowed.has(field));
    if (rejectedFields.length > 0) {
      return ctx.badRequest("Homepage product payload contains protected settings fields", {
        fields: rejectedFields.sort(),
      });
    }
    const data: Record<string, unknown> = {};
    for (const field of HOMEPAGE_PRODUCT_ID_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      const sanitized = sanitizeHomepageProductIds(payload[field]);
      if (!sanitized) {
        return ctx.badRequest(`${field} must be an array of positive product ids`);
      }
      data[field] = sanitized;
    }
    for (const field of HOMEPAGE_PRODUCT_ENABLED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      const value = payload[field];
      if (typeof value !== "boolean") {
        return ctx.badRequest(`${field} must be a boolean`);
      }
      data[field] = value;
    }
    const settingsEntity = await ensureSettingsEntity(strapi);
    const expectedRevision = ctx.request.body?.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return sendCatalogEditError(ctx, new CatalogEditError("HOMEPAGE_VERSION_CONFLICT"));
    }
    let changed = false;
    const changedMembership = new Set<number>();
    for (const field of HOMEPAGE_PRODUCT_ID_FIELDS) {
      if (!(field in data)) continue;
      const before = new Set<number>(settingsEntity[field] || []);
      const after = new Set<number>(data[field] as number[]);
      for (const id of before) if (!after.has(id)) changedMembership.add(id);
      for (const id of after) if (!before.has(id)) changedMembership.add(id);
    }
    const mutate = async (trx: any) => {
      const locked = await trx("settings").where({ id: settingsEntity.id }).forUpdate().first();
      if (Number(locked.homepage_products_revision || 0) !== expectedRevision) throw new CatalogEditError("HOMEPAGE_VERSION_CONFLICT");
      data.HomepageProductsRevision = expectedRevision + 1;
      const entity = await withHomepageSettingsWrite(() => strapi.entityService.update(SETTINGS_UID, settingsEntity.id, {
        data,
        transacting: trx,
      }));
      const changes = settingChanges(settingsEntity, entity, Object.keys(data));
      changed = changes.length > 0;
      await writeAuditEvent(
        strapi,
        {
          eventKey: "content.changed",
          result: changes.length > 0 ? "success" : "no_op",
          target: { type: "settings", id: settingsEntity.id, label: "محصولات صفحه اصلی" },
          changes,
          summaryFa:
            changes.length > 0
              ? "تنظیمات محصولات صفحه اصلی تغییر کرد"
              : "تنظیمات محصولات صفحه اصلی تغییری نکرد",
          summaryEn:
            changes.length > 0
              ? "Homepage product settings changed"
              : "Homepage product settings did not change",
          metadata: { section: "homepage_products", changedFieldCount: changes.length },
          dedupeKey: settingsDedupeKey("homepage-products", settingsEntity.id),
        },
        { trx },
      );
      return entity;
    };
    let updated: any;
    try {
      if (changedMembership.size) {
        const editor = await staffEditor(ctx, strapi);
        updated = (await runCatalogMutation(strapi, [...changedMembership], { kind: "transient", editor }, mutate)).value;
      } else {
        updated = await strapi.db.transaction(({ trx }) => mutate(trx));
      }
    } catch (error) { return sendCatalogEditError(ctx, error); }
    // The rails and the Newest listing read these ids per request, but the product
    // endpoint caches (homepage-sections, rest-cache card lists) only clear on product
    // writes, so a reorder would otherwise wait out their TTLs.
    if (changed) await clearAllProductCaches(strapi, "homepage-products");
    ctx.body = {
      data: {
        id: updated.id,
        attributes: projectHomepageProductSettings(updated),
      },
    };
  },

  async resolveHomepageProductMappings(ctx) {
    const payload = extractPayloadFromRequestBody(ctx.request.body);
    const sourceIds = sanitizeWooSourceIds(payload?.sourceIds);
    if (!sourceIds || sourceIds.length === 0) {
      return ctx.badRequest("sourceIds must contain 1 to 1000 positive WooCommerce product ids");
    }
    const rows = await strapi.db.query("api::product.product").findMany({
      where: {
        external_source: "woocommerce",
        external_id: { $in: sourceIds },
      },
      select: ["id", "external_id", "external_source"],
    });
    ctx.body = { data: rows };
  },

  async getGifPromoProducts(ctx) {
    const settingsEntity = await ensureSettingsEntity(strapi);
    ctx.body = {
      data: {
        id: settingsEntity.id,
        attributes: {
          // Slot images are edited under site customization; surfaced here
          // read-only so staff can see what their product picks pair with.
          homeGifPromoSlot1Image:
            typeof settingsEntity.homeGifPromoSlot1Image === "string"
              ? settingsEntity.homeGifPromoSlot1Image
              : "",
          homeGifPromoSlot2Image:
            typeof settingsEntity.homeGifPromoSlot2Image === "string"
              ? settingsEntity.homeGifPromoSlot2Image
              : "",
          ...projectAssignmentFieldSettings(settingsEntity, GIF_PROMO_FIELDS),
        },
      },
    };
  },

  async updateGifPromoProducts(ctx) {
    const payload = extractPayloadFromRequestBody(ctx.request.body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return ctx.badRequest("Gif promo product payload must be an object");
    }
    const allowed = new Set<string>(GIF_PROMO_FIELDS);
    const rejectedFields = Object.keys(payload).filter((field) => !allowed.has(field));
    if (rejectedFields.length > 0) {
      return ctx.badRequest("Gif promo product payload contains protected settings fields", {
        fields: rejectedFields.sort(),
      });
    }
    const data: Record<string, unknown> = {};
    for (const field of GIF_PROMO_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      data[field] = normalizeHomeProductAssignment(payload[field]);
    }
    const settingsEntity = await ensureSettingsEntity(strapi);
    const updated = await strapi.db.transaction(async ({ trx }) => {
      const entity = await strapi.entityService.update(SETTINGS_UID, settingsEntity.id, {
        data,
        transacting: trx,
      });
      const changes = settingChanges(settingsEntity, entity, Object.keys(data));
      await writeAuditEvent(
        strapi,
        {
          eventKey: "content.changed",
          result: changes.length > 0 ? "success" : "no_op",
          target: { type: "settings", id: settingsEntity.id, label: "محصولات کمپین گیف" },
          changes,
          summaryFa:
            changes.length > 0
              ? "تنظیمات محصولات کمپین گیف تغییر کرد"
              : "تنظیمات محصولات کمپین گیف تغییری نکرد",
          summaryEn:
            changes.length > 0
              ? "Gif promo product settings changed"
              : "Gif promo product settings did not change",
          metadata: { section: "gif_promo_products", changedFieldCount: changes.length },
          dedupeKey: settingsDedupeKey("gif-promo-products", settingsEntity.id),
        },
        { trx },
      );
      return entity;
    });
    ctx.body = {
      data: {
        id: updated.id,
        attributes: {
          homeGifPromoSlot1Image:
            typeof updated.homeGifPromoSlot1Image === "string" ? updated.homeGifPromoSlot1Image : "",
          homeGifPromoSlot2Image:
            typeof updated.homeGifPromoSlot2Image === "string" ? updated.homeGifPromoSlot2Image : "",
          ...projectAssignmentFieldSettings(updated, GIF_PROMO_FIELDS),
        },
      },
    };
  },

  async getHomepageCustomSection(ctx) {
    const settingsEntity = await ensureSettingsEntity(strapi);
    ctx.body = {
      data: {
        id: settingsEntity.id,
        attributes: {
          ...projectCustomSectionSettings(settingsEntity),
          ...projectAssignmentFieldSettings(settingsEntity, CUSTOM_SECTION_ASSIGNMENT_FIELDS),
        },
      },
    };
  },

  async updateHomepageCustomSection(ctx) {
    const payload = extractPayloadFromRequestBody(ctx.request.body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return ctx.badRequest("Homepage custom section payload must be an object");
    }
    const allowed = new Set<string>(CUSTOM_SECTION_FIELDS);
    const rejectedFields = Object.keys(payload).filter((field) => !allowed.has(field));
    if (rejectedFields.length > 0) {
      return ctx.badRequest("Homepage custom section payload contains protected settings fields", {
        fields: rejectedFields.sort(),
      });
    }
    const data: Record<string, unknown> = {};
    for (const field of CUSTOM_SECTION_ENABLED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      const value = payload[field];
      if (typeof value !== "boolean") {
        return ctx.badRequest(`${field} must be a boolean`);
      }
      data[field] = value;
    }
    for (const field of CUSTOM_SECTION_TITLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      const value = payload[field];
      if (typeof value !== "string") {
        return ctx.badRequest(`${field} must be a string`);
      }
      data[field] = value.trim();
    }
    for (const field of CUSTOM_SECTION_LINK_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      const href = sanitizeCustomSectionHref(payload[field]);
      if (href === null) {
        return ctx.badRequest(`${field} must be an internal path starting with /`);
      }
      data[field] = href;
    }
    for (const field of CUSTOM_SECTION_ASSIGNMENT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      data[field] = normalizeHomeProductAssignment(payload[field]);
    }
    const settingsEntity = await ensureSettingsEntity(strapi);
    const updated = await strapi.db.transaction(async ({ trx }) => {
      const entity = await strapi.entityService.update(SETTINGS_UID, settingsEntity.id, {
        data,
        transacting: trx,
      });
      const changes = settingChanges(settingsEntity, entity, Object.keys(data));
      await writeAuditEvent(
        strapi,
        {
          eventKey: "content.changed",
          result: changes.length > 0 ? "success" : "no_op",
          target: { type: "settings", id: settingsEntity.id, label: "بخش ویژه صفحه اصلی" },
          changes,
          summaryFa:
            changes.length > 0
              ? "تنظیمات بخش ویژه صفحه اصلی تغییر کرد"
              : "تنظیمات بخش ویژه صفحه اصلی تغییری نکرد",
          summaryEn:
            changes.length > 0
              ? "Homepage custom section settings changed"
              : "Homepage custom section settings did not change",
          metadata: { section: "homepage_custom_section", changedFieldCount: changes.length },
          dedupeKey: settingsDedupeKey("homepage-custom-section", settingsEntity.id),
        },
        { trx },
      );
      return entity;
    });
    ctx.body = {
      data: {
        id: updated.id,
        attributes: {
          ...projectCustomSectionSettings(updated),
          ...projectAssignmentFieldSettings(updated, CUSTOM_SECTION_ASSIGNMENT_FIELDS),
        },
      },
    };
  },

  async getHeroSlider(ctx) {
    const settingsEntity = await ensureSettingsEntity(strapi);

    const draft = normalizeStoredHeroSliderPayload(settingsEntity.homeHeroSliderDraft);
    const published = normalizeStoredHeroSliderPayload(settingsEntity.homeHeroSliderPublished);
    const meta =
      settingsEntity.homeHeroSliderMeta && typeof settingsEntity.homeHeroSliderMeta === "object"
        ? settingsEntity.homeHeroSliderMeta
        : {};

    ctx.body = {
      data: {
        draft,
        published,
        meta,
      },
    };
  },

  async updateHeroSliderDraft(ctx) {
    const payload = extractPayloadFromRequestBody(ctx.request.body);
    const { value, errors } = sanitizeHeroSliderPayload(payload);

    if (errors.length > 0) {
      return ctx.badRequest("Invalid hero slider draft payload", {
        errors,
      });
    }

    const settingsEntity = await ensureSettingsEntity(strapi);
    const before = heroSliderSnapshot(settingsEntity.homeHeroSliderDraft);
    const after = heroSliderSnapshot(value);
    const updated = await strapi.db.transaction(async ({ trx }) => {
      const entity = await strapi.entityService.update(SETTINGS_UID, settingsEntity.id, {
        data: {
          homeHeroSliderDraft: toStrapiJson(value),
        },
        transacting: trx,
      });
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      await writeAuditEvent(
        strapi,
        {
          eventKey: "content.changed",
          result: changed ? "success" : "no_op",
          target: { type: "settings", id: settingsEntity.id, label: "اسلایدر صفحه اصلی" },
          changes: [{ field: "homeHeroSliderDraft", label: "پیش‌نویس اسلایدر", from: before, to: after }],
          summaryFa: changed
            ? `پیش‌نویس اسلایدر صفحه اصلی با ${after.slideCount} اسلاید ویرایش شد`
            : "پیش‌نویس اسلایدر صفحه اصلی تغییری نکرد",
          summaryEn: changed
            ? `Homepage slider draft changed to ${after.slideCount} slides`
            : "Homepage slider draft did not change",
          metadata: { section: "homepage_slider", stage: "draft" },
          dedupeKey: settingsDedupeKey("hero-slider-draft", settingsEntity.id),
        },
        { trx },
      );
      return entity;
    });

    ctx.body = {
      data: {
        draft: normalizeStoredHeroSliderPayload(updated.homeHeroSliderDraft),
      },
    };
  },

  async publishHeroSliderDraft(ctx) {
    const settingsEntity = await ensureSettingsEntity(strapi);
    const { value, errors } = sanitizeHeroSliderPayload(settingsEntity.homeHeroSliderDraft);

    if (errors.length > 0) {
      return ctx.badRequest("Cannot publish invalid hero slider draft", {
        errors,
      });
    }

    const publishedBy =
      ctx.state?.user && Number.isFinite(Number(ctx.state.user.id))
        ? Number(ctx.state.user.id)
        : null;
    const meta = createHeroSliderMeta(publishedBy);

    const before = heroSliderSnapshot(settingsEntity.homeHeroSliderPublished);
    const after = heroSliderSnapshot(value);
    const updated = await strapi.db.transaction(async ({ trx }) => {
      const entity = await strapi.entityService.update(SETTINGS_UID, settingsEntity.id, {
        data: {
          homeHeroSliderPublished: toStrapiJson(value),
          homeHeroSliderMeta: toStrapiJson(meta),
        },
        transacting: trx,
      });
      await writeAuditEvent(
        strapi,
        {
          eventKey: "content.changed",
          importance: "important",
          result: "success",
          target: { type: "settings", id: settingsEntity.id, label: "اسلایدر صفحه اصلی" },
          changes: [{ field: "homeHeroSliderPublished", label: "نسخه منتشرشده", from: before, to: after }],
          summaryFa: `اسلایدر صفحه اصلی با ${after.slideCount} اسلاید منتشر شد`,
          summaryEn: `Homepage slider was published with ${after.slideCount} slides`,
          metadata: { section: "homepage_slider", stage: "published" },
          dedupeKey: settingsDedupeKey("hero-slider-publish", settingsEntity.id),
        },
        { trx },
      );
      return entity;
    });

    await triggerHeroSliderRevalidation(strapi);

    ctx.body = {
      data: {
        published: normalizeStoredHeroSliderPayload(updated.homeHeroSliderPublished),
        meta: updated.homeHeroSliderMeta,
      },
    };
  },
}));
