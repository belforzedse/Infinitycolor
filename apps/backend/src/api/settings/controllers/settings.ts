// @ts-nocheck
/**
 * settings controller
 */

import { getFrontendUrls } from "../../../utils/revalidate";
import type { Attribute } from "@strapi/types";
import { factories } from "@strapi/strapi";
import {
  createHeroSliderMeta,
  normalizeStoredHeroSliderPayload,
  sanitizeHeroSliderPayload,
} from "../services/hero-slider-schema";

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
    const updated = await strapi.entityService.update(SETTINGS_UID, settingsEntity.id, { data });
    ctx.body = {
      data: {
        id: updated.id,
        attributes: projectBlogBannerSettings(updated),
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
    const updated = await strapi.entityService.update(SETTINGS_UID, settingsEntity.id, {
      data: {
        homeHeroSliderDraft: toStrapiJson(value),
      },
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

    const updated = await strapi.entityService.update(SETTINGS_UID, settingsEntity.id, {
      data: {
        homeHeroSliderPublished: toStrapiJson(value),
        homeHeroSliderMeta: toStrapiJson(meta),
      },
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
