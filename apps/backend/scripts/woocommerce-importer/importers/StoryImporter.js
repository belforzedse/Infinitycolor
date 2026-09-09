"use strict";

const axios = require("axios");
const { StrapiClient } = require("../utils/ApiClient");
const ImageUploader = require("../utils/ImageUploader");
const {
  flattenWpStories,
  parseHomepageStories,
  reverseForNewestFirst,
} = require("../lib/storyTransform");

const STORIES_ENDPOINT = "/stories";
const DEFAULT_HOMEPAGE = "https://infinitycolor.co/";

function unwrapEntry(entry) {
  if (!entry) return null;
  if (entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)) {
    return unwrapEntry(entry.data);
  }
  if (entry.attributes && typeof entry.attributes === "object") {
    return { id: entry.id, ...entry.attributes };
  }
  return entry;
}

function entryId(entry) {
  const unwrapped = unwrapEntry(entry);
  const id = Number(unwrapped?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

class StoryImporter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.strapiClient = new StrapiClient(config, logger);
    this.imageUploader = new ImageUploader(config, logger);
    this.stats = {
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      deactivated: 0,
      startTime: null,
      endTime: null,
    };
  }

  homepageUrl() {
    const override = String(process.env.WORDPRESS_HOMEPAGE_URL || "").trim();
    if (override) return override;
    try {
      return `${new URL(this.config.wordpress.baseUrl).origin}/`;
    } catch {
      return DEFAULT_HOMEPAGE;
    }
  }

  async fetchHomepageHtml() {
    const url = this.homepageUrl();
    this.logger.info(`📥 Fetching WP story rail from ${url}`);
    const response = await axios.get(url, {
      timeout: 60_000,
      headers: { "User-Agent": "Infinitycolor-Story-Importer/1.0" },
      responseType: "text",
      transformResponse: [(data) => data],
    });
    if (typeof response.data !== "string" || !response.data) {
      throw new Error("Homepage response was empty");
    }
    return response.data;
  }

  async import(options = {}) {
    const { dryRun = false, deactivateExisting = false } = options;
    this.stats.startTime = Date.now();

    const html = await this.fetchHomepageHtml();
    const circles = parseHomepageStories(html);
    const slides = flattenWpStories(circles);
    const ordered = reverseForNewestFirst(slides);
    this.stats.total = ordered.length;

    this.logger.info(
      `🎬 Found ${circles.length} WP story circles (${slides.length} slides). dryRun=${dryRun}`,
    );

    if (ordered.length === 0) {
      this.logger.warn("📭 No story slides to import");
      this.stats.endTime = Date.now();
      return this.stats;
    }

    this.logger.startProgress(ordered.length, "Importing stories");

    const importedSlugs = new Set(ordered.map((slide) => slide.slug));

    for (const slide of ordered) {
      try {
        await this.importSlide(slide, { dryRun });
      } catch (error) {
        this.stats.failed += 1;
        this.logger.error(`❌ Failed to import ${slide.slug} (${slide.title}):`, error.message);
        if (!this.config.errorHandling?.continueOnError) {
          throw error;
        }
      } finally {
        this.logger.updateProgress();
      }
    }

    this.logger.completeProgress();

    if (deactivateExisting) {
      await this.deactivateOtherActiveStories(importedSlugs, { dryRun });
    }

    this.stats.endTime = Date.now();
    this.logSummary();
    return this.stats;
  }

  async importSlide(slide, { dryRun }) {
    const existing = await this.findStoryBySlug(slide.slug);
    const existingId = entryId(existing);

    if (dryRun) {
      this.logger.info(
        `🔍 ${existingId ? "update" : "create"} ${slide.slug} — ${slide.title} (${slide.mediaType}, ${slide.durationMs}ms)`,
      );
      this.stats.skipped += 1;
      return;
    }

    const media = await this.imageUploader.downloadAndUploadMedia(
      slide.mediaUrl,
      slide.title,
      `story-${slide.slug}-media`,
      true,
    );
    if (!media?.id) {
      throw new Error(`Media upload failed for ${slide.mediaUrl}`);
    }

    let thumbnailId;
    if (slide.thumbnailUrl) {
      const thumbnail = await this.imageUploader.downloadAndUploadMedia(
        slide.thumbnailUrl,
        `${slide.title} cover`,
        `story-${slide.slug}-thumb`,
        true,
      );
      thumbnailId = thumbnail?.id;
      if (!thumbnailId) {
        this.logger.warn(`⚠️ Thumbnail upload failed for ${slide.slug}, continuing without cover`);
      }
    }

    const data = {
      Title: slide.title,
      Slug: slide.slug,
      IsActive: true,
      SortOrder: slide.sortOrder,
      MediaType: slide.mediaType,
      Media: media.id,
      DurationMs: slide.durationMs,
    };
    if (thumbnailId) data.Thumbnail = thumbnailId;
    if (slide.ctaLabel) data.CtaLabel = slide.ctaLabel;
    if (slide.ctaUrl) data.CtaUrl = slide.ctaUrl;

    if (existingId) {
      await this.strapiClient.update(STORIES_ENDPOINT, existingId, data);
      this.stats.updated += 1;
      this.logger.success(`♻️ Updated story ${slide.slug} (id ${existingId})`);
      return;
    }

    const created = await this.strapiClient.create(STORIES_ENDPOINT, data);
    const createdId = entryId(created);
    this.stats.created += 1;
    this.logger.success(`✅ Created story ${slide.slug} (id ${createdId ?? "?"})`);
  }

  async findStoryBySlug(slug) {
    const payload = await this.strapiClient.get(STORIES_ENDPOINT, {
      "filters[Slug][$eq]": slug,
      "pagination[pageSize]": 1,
    });
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return unwrapEntry(rows[0]);
  }

  async listActiveStories() {
    const stories = [];
    let page = 1;
    while (true) {
      const payload = await this.strapiClient.get(STORIES_ENDPOINT, {
        "filters[IsActive][$eq]": true,
        "pagination[page]": page,
        "pagination[pageSize]": 100,
        sort: "id:asc",
      });
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      stories.push(...rows.map(unwrapEntry).filter(Boolean));
      const pageCount = Number(payload?.meta?.pagination?.pageCount || 1);
      if (page >= pageCount || rows.length === 0) break;
      page += 1;
    }
    return stories;
  }

  async deactivateOtherActiveStories(keepSlugs, { dryRun }) {
    const active = await this.listActiveStories();
    const extras = active.filter((story) => story?.Slug && !keepSlugs.has(story.Slug));
    this.logger.info(`🧹 ${extras.length} active stor${extras.length === 1 ? "y" : "ies"} not in the WP rail`);

    for (const story of extras) {
      const id = entryId(story);
      if (!id) continue;
      if (dryRun) {
        this.logger.info(`🔍 would deactivate id=${id} slug=${story.Slug} title=${story.Title}`);
        this.stats.deactivated += 1;
        continue;
      }
      await this.strapiClient.update(STORIES_ENDPOINT, id, { IsActive: false });
      this.stats.deactivated += 1;
      this.logger.success(`💤 Deactivated story id=${id} (${story.Slug})`);
    }
  }

  logSummary() {
    const elapsed = this.stats.endTime && this.stats.startTime
      ? Math.round((this.stats.endTime - this.stats.startTime) / 1000)
      : 0;
    this.logger.info(
      `📊 Stories import: total=${this.stats.total} created=${this.stats.created} updated=${this.stats.updated} skipped=${this.stats.skipped} failed=${this.stats.failed} deactivated=${this.stats.deactivated} (${elapsed}s)`,
    );
  }
}

module.exports = StoryImporter;
