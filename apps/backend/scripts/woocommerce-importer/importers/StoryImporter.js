"use strict";

const axios = require("axios");
const { StrapiClient } = require("../utils/ApiClient");
const ImageUploader = require("../utils/ImageUploader");
const {
  groupWpStories,
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
    const groups = groupWpStories(circles);
    const ordered = reverseForNewestFirst(groups);
    this.stats.total = ordered.length;

    this.logger.info(
      `🎬 Found ${groups.length} importable WP story circles (${groups.reduce((sum, group) => sum + group.items.length, 0)} items). dryRun=${dryRun}`,
    );

    if (ordered.length === 0) {
      this.logger.warn("📭 No story circles to import");
      this.stats.endTime = Date.now();
      return this.stats;
    }

    this.logger.startProgress(ordered.length, "Importing stories");

    const importedSlugs = new Set();

    for (const group of ordered) {
      try {
        const imported = await this.importGroup(group, { dryRun, deactivateExisting });
        if (imported) importedSlugs.add(group.slug);
      } catch (error) {
        this.stats.failed += 1;
        this.logger.error(`❌ Failed to import ${group.slug} (${group.title}):`, error.message);
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

  async importGroup(group, { dryRun, deactivateExisting }) {
    const existing = await this.findStoryBySlug(group.slug);
    const existingId = entryId(existing);
    const legacyRows = await this.findActiveLegacyStories(group.wpStoryId);

    if (legacyRows.length > 0) {
      const affected = legacyRows.map((row) => `${entryId(row)}:${row.Slug}`).join(", ");
      this.logger.warn(
        `⚠️ ${group.slug} would replace ${legacyRows.length} active flattened row(s): ${affected}`,
      );
      if (!deactivateExisting) {
        this.logger.warn(`⏭️ Skipping ${group.slug}; pass --deactivate-existing to migrate this circle safely`);
        this.stats.skipped += 1;
        return false;
      }
    }

    if (dryRun) {
      this.logger.info(
        `🔍 ${existingId ? "update" : "create"} ${group.slug} — ${group.title} (${group.items.length} ordered items)`,
      );
      this.stats.skipped += 1;
      return true;
    }

    const items = [];
    for (const item of group.items) {
      const media = await this.imageUploader.downloadAndUploadMedia(
        item.mediaUrl,
        group.title,
        `story-${group.slug}-${item.itemIndex}-media`,
        true,
      );
      if (!media?.id) throw new Error(`Media upload failed for ${item.mediaUrl}`);
      items.push({
        Key: item.key,
        MediaType: item.mediaType,
        Media: media.id,
        DurationMs: item.durationMs,
        CtaUrl: item.ctaUrl || null,
        CtaLabel: "مشاهده لینک",
      });
    }

    let thumbnailId;
    if (group.thumbnailUrl) {
      const thumbnail = await this.imageUploader.downloadAndUploadMedia(
        group.thumbnailUrl,
        `${group.title} cover`,
        `story-${group.slug}-thumb`,
        true,
      );
      thumbnailId = thumbnail?.id;
      if (!thumbnailId) {
        this.logger.warn(`⚠️ Thumbnail upload failed for ${group.slug}, continuing without cover`);
      }
    }

    const data = {
      Title: group.title,
      Slug: group.slug,
      IsActive: true,
      SortOrder: group.sortOrder,
      Items: items,
    };
    if (thumbnailId) data.Thumbnail = thumbnailId;

    if (existingId) {
      await this.strapiClient.update(STORIES_ENDPOINT, existingId, data);
      this.stats.updated += 1;
      this.logger.success(`♻️ Updated story ${group.slug} (id ${existingId})`);
    } else {
      const created = await this.strapiClient.create(STORIES_ENDPOINT, data);
      const createdId = entryId(created);
      this.stats.created += 1;
      this.logger.success(`✅ Created story ${group.slug} (id ${createdId ?? "?"})`);
    }

    const verified = await this.findStoryBySlug(group.slug, true);
    const savedItems = Array.isArray(verified?.Items) ? verified.Items : [];
    const savedKeys = savedItems.map((item) => item?.Key).filter(Boolean);
    const expectedKeys = group.items.map((item) => item.key);
    if (savedKeys.length !== expectedKeys.length || savedKeys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error(`Verification failed for ${group.slug}: saved item order does not match source`);
    }

    if (deactivateExisting && legacyRows.length > 0) {
      for (const legacy of legacyRows) {
        const id = entryId(legacy);
        if (!id) continue;
        await this.strapiClient.update(STORIES_ENDPOINT, id, { IsActive: false });
        this.stats.deactivated += 1;
        this.logger.success(`💤 Deactivated legacy story id=${id} (${legacy.Slug})`);
      }
    }
    return true;
  }

  async findStoryBySlug(slug, populateItems = false) {
    const params = {
      "filters[Slug][$eq]": slug,
      "pagination[pageSize]": 1,
    };
    if (populateItems) params["populate[Items]"] = true;
    const payload = await this.strapiClient.get(STORIES_ENDPOINT, params);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return unwrapEntry(rows[0]);
  }

  async findActiveLegacyStories(wpStoryId) {
    const payload = await this.strapiClient.get(STORIES_ENDPOINT, {
      "filters[IsActive][$eq]": true,
      "filters[Slug][$startsWith]": `wp-${wpStoryId}-`,
      "pagination[pageSize]": 100,
      sort: "SortOrder:asc",
    });
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return rows.map(unwrapEntry).filter(Boolean);
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
