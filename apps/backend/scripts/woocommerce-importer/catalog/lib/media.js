"use strict";

const ImageUploader = require("../../utils/ImageUploader");
const { splitWcMediaItems, extractVideoUrlsFromMeta, isEmbedVideoUrl } = require("../../utils/mediaUtils");
const { validateMediaUrl } = require("./safeUrl");
const { wooSourceTimestamps } = require("../../utils/sourceTimestamps");
const { canonicalSourceUrl } = require("./mediaMappingStore");
const { mapPoolOrdered } = require("./concurrency");

/**
 * Media synchronization with persistent deduplication and an SSRF guard.
 *
 * Fixes two legacy problems:
 *  1. The old uploader cached uploads only in memory, so every run re-downloaded
 *     and re-uploaded every image (and `generateFileName` used a timestamp, so
 *     Strapi couldn't dedup either). Here a persistent URL → Strapi-file-id map
 *     means each image is uploaded once and reused forever.
 *  2. The old uploader downloaded any URL with no validation. Here every URL is
 *     checked against an SSRF guard before any network call.
 *
 * The actual download/convert(WebP)/upload is delegated to the existing
 * `ImageUploader` (working code we deliberately reuse rather than rewrite).
 */
class MediaSync {
  /**
   * @param {object} config
   * @param {object} logger
   * @param {import('./mapping')} mediaStore persistent MappingStore (type "media", keyed by URL)
   * @param {object} [opts]
   * @param {boolean} [opts.allowHttp=false]
   */
  constructor(config, logger, mediaStore, opts = {}) {
    this.config = config;
    this.logger = logger;
    this.store = mediaStore;
    this.allowHttp = opts.allowHttp ?? false;
    this.uploader = new ImageUploader(config, logger);
    this.videoConfig = config.import?.videos || {};
    this.maxGallery = config.import?.images?.maxImagesPerProduct ?? 999;
    this.imageConcurrency = opts.imageConcurrency || config.catalog?.concurrency?.images || 4;
    this.videoConcurrency = opts.videoConcurrency || config.catalog?.concurrency?.videos || 1;
    this.canStart = opts.canStart || null;
    this.inFlight = new Map();
  }

  /**
   * Sync a single media URL. Returns `{ id, mime, status }` where status is one of
   * "reused" | "uploaded" | "failed".
   * @param {string} url
   * @param {string} altText
   * @param {string} prefix
   * @param {boolean} isCover
   */
  async syncUrl(url, altText, prefix, isCover = false, sourceTimestamps = null) {
    let canonical;
    try {
      canonical = canonicalSourceUrl(url);
    } catch {
      return { id: null, mime: null, status: "failed" };
    }
    const existing = this.inFlight.get(canonical);
    if (existing) return existing;
    const pending = this._syncUrl(canonical, altText, prefix, isCover, sourceTimestamps);
    this.inFlight.set(canonical, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(canonical);
    }
  }

  async _syncUrl(url, altText, prefix, isCover = false, sourceTimestamps = null) {
    // 1. Persistent dedup — already uploaded in a previous run?
    const cached = this.store.get("media", url);
    if (cached && cached.strapiId) {
      await this.uploader.restoreMediaSourceTimestamps?.(cached.strapiId, sourceTimestamps);
      this.logger.debug(`♻️ Reusing media source hash → ${cached.strapiId}`);
      return { id: cached.strapiId, mime: cached.mime, status: "reused" };
    }

    // 2. SSRF guard before any network access
    const check = validateMediaUrl(url, { allowHttp: this.allowHttp });
    if (!check.ok) {
      this.logger.warn(`🚫 Blocked unsafe media URL (${check.reason})`);
      return { id: null, mime: null, status: "failed" };
    }

    // 3. Delegate download/convert/upload to the existing uploader
    const uploaded = await this.uploader.downloadAndUploadMedia(
      url,
      altText,
      prefix,
      isCover,
      sourceTimestamps,
    );
    if (!uploaded || !uploaded.id) {
      return { id: null, mime: null, status: "failed" };
    }
    if (uploaded._reusedDeterministic) {
      await this.uploader.restoreMediaSourceTimestamps?.(uploaded.id, sourceTimestamps);
    }

    await this.observer?.afterMediaUploadBeforeMappingCommit?.({
      sourceHash: this.uploader.sourceHash?.(url),
      destinationId: uploaded.id,
    });
    this.store.set("media", url, uploaded.id, { name: uploaded.name, mime: uploaded.mime });
    return {
      id: uploaded.id,
      mime: uploaded.mime,
      status: uploaded._reusedDeterministic ? "reused" : "uploaded",
    };
  }

  /**
   * Resolve all media for a product into an ordered set of ids.
   *
   * Returns `{ coverId, galleryIds, counts }`. The caller attaches these to the
   * Strapi product ONLY when ids are present — it never nulls existing media on a
   * failed re-download (the legacy data-loss bug).
   *
   * @param {object} wcProduct
   */
  async syncProductMedia(wcProduct) {
    const counts = { uploaded: 0, reused: 0, failed: 0 };
    const failures = { cover: false, gallery: false };
    const allowedVideoTypes = this.videoConfig.allowedTypes || ["mp4", "webm", "mov", "m4v"];
    const imagesEnabled = this.config.import?.images?.enableUpload !== false;
    const videosEnabled = this.videoConfig.enableUpload !== false;

    const split = splitWcMediaItems(wcProduct.images, allowedVideoTypes);
    const metaVideoUrls = videosEnabled ? extractVideoUrlsFromMeta(wcProduct, this.videoConfig.metaKeys) : [];

    let coverId = null;
    const galleryIds = [];
    const track = (res) => {
      if (res.status === "uploaded") counts.uploaded += 1;
      else if (res.status === "reused") counts.reused += 1;
      else counts.failed += 1;
      return res;
    };

    // Images execute concurrently, but results are collected by source index so
    // cover/gallery relations remain deterministic.
    if (imagesEnabled && split.images.length > 0) {
      const imageInputs = split.images.slice(0, this.maxGallery + 1);
      const results = await mapPoolOrdered(imageInputs, this.imageConcurrency, async (image, index) => {
        const res = await this.syncUrl(
          image.src,
          image.alt || (index === 0 ? wcProduct.name : `${wcProduct.name} - ${index}`),
          index === 0 ? `product-${wcProduct.id}-cover` : `product-${wcProduct.id}-gallery-${index}`,
          index === 0,
          wooSourceTimestamps(image),
        );
        return track(res);
      }, { canStart: this.canStart });
      coverId = results[0]?.id || null;
      failures.cover = Boolean(results[0] && !results[0].id);
      for (let index = 1; index < results.length; index += 1) {
        if (results[index]?.id) galleryIds.push(results[index].id);
        else failures.gallery = true;
      }
    } else if (videosEnabled && split.videos.length > 0) {
      const v = split.videos[0];
      const res = track(await this.syncUrl(
        v.src,
        v.alt || wcProduct.name,
        `product-${wcProduct.id}-cover-video`,
        true,
        wooSourceTimestamps(v),
      ));
      coverId = res.id;
      failures.cover = !res.id;
    }

    // Videos (from images array + meta), skipping embeds
    if (videosEnabled) {
      const galleryVideos = split.videos.slice(coverId && split.images.length === 0 ? 1 : 0);
      const videoUrls = [
        ...galleryVideos.map((v) => v.src),
        ...metaVideoUrls.filter((u) => !isEmbedVideoUrl(u)),
      ];
      const seen = new Set(split.images.map((i) => i.src));
      const uniqueVideos = videoUrls.filter((url) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      }).slice(0, Math.max(0, this.maxGallery - galleryIds.length));
      const videoResults = await mapPoolOrdered(uniqueVideos, this.videoConcurrency, async (url, index) => track(await this.syncUrl(
        url,
        `${wcProduct.name} - video ${index + 1}`,
        `product-${wcProduct.id}-video-${index + 1}`,
        false,
        null,
      )), { canStart: this.canStart });
      for (const result of videoResults) if (result?.id) galleryIds.push(result.id);
      if (videoResults.some((result) => !result?.id)) failures.gallery = true;
    }

    return { coverId, galleryIds, counts, failures };
  }
}

module.exports = MediaSync;
