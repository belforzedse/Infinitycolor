const axios = require("axios");
const crypto = require("crypto");
const dns = require("dns").promises;
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { detectMediaKind, isEmbedVideoUrl } = require("./mediaUtils");
const { sourceTimestampHeaders } = require("./sourceTimestamps");
const { validateMediaUrl, isPrivateHost } = require("../catalog/lib/safeUrl");
const { canonicalSourceUrl } = require("../catalog/lib/mediaMappingStore");
const { computeBackoffDelay } = require("../catalog/lib/backoff");

sharp.cache({ memory: 64, files: 0, items: 100 });
sharp.concurrency(2);

let sharpQueueDepth = 0;
let sharpQueuePeak = 0;
sharp.queue.on("change", (depth) => {
  sharpQueueDepth = depth;
  sharpQueuePeak = Math.max(sharpQueuePeak, depth);
});

/**
 * ImageUploader - Handles downloading and uploading images and videos from WooCommerce to Strapi
 */
class ImageUploader {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.tempDir = path.join(__dirname, "../temp");
    this.metrics = {
      downloadBytes: 0,
      downloadMs: 0,
      conversionMs: 0,
      uploadMs: 0,
      sharpQueuePeak: 0,
      sharpProcessPeak: 0,
    };

    const imageConfig = this.getImageConfig();
    if (!imageConfig.retry) {
      imageConfig.retry = {
        coverImageDownloadRetries: 3,
        coverImageUploadRetries: 3,
        galleryImageDownloadRetries: 3,
        galleryImageUploadRetries: 3,
        initialRetryDelay: 1000,
        maxRetryDelay: 10000,
        retryMultiplier: 2,
      };
    }

    this.ensureTempDir();
  }

  getImageConfig() {
    return this.config.import?.images || this.config.images || {};
  }

  getVideoConfig() {
    return this.config.import?.videos || this.config.videos || {};
  }

  getAudioConfig() {
    return this.config.import?.audio || this.config.audio || {};
  }

  getStrapiConfig() {
    return this.config.strapi || {};
  }

  async restoreMediaSourceTimestamps(mediaId, sourceTimestamps) {
    if (!sourceTimestamps || !this.config.migration?.controlToken) return;
    const strapiConfig = this.getStrapiConfig();
    const headers = {
      "Content-Type": "application/json",
      "X-Infinity-Migration-Mode": "wordpress-v2",
      "X-Infinity-Migration-Control": this.config.migration.controlToken,
      ...sourceTimestampHeaders(sourceTimestamps),
    };
    if (!strapiConfig.usePublicAccess && strapiConfig.auth?.token) {
      headers.Authorization = `Bearer ${strapiConfig.auth.token}`;
    }
    await axios.post(
      `${strapiConfig.baseUrl}/internal/migrations/wordpress-v2/media/timestamps`,
      { id: mediaId },
      { headers, timeout: 60_000 },
    );
  }

  /**
   * Download and upload cover image for a product (first image entry only — legacy/blog path)
   */
  async handleCoverImage(wcProduct, strapiProductId) {
    try {
      const coverImageData =
        wcProduct.images && wcProduct.images.length > 0 ? wcProduct.images[0] : null;

      if (!coverImageData || !coverImageData.src) {
        this.logger.warn(`📸 No cover image found for product: ${wcProduct.name}`);
        return null;
      }

      const kind = detectMediaKind(
        coverImageData.src,
        undefined,
        this.getVideoConfig().allowedTypes || ["mp4", "webm", "mov", "m4v"],
      );
      if (kind !== "image") {
        this.logger.debug(
          `📸 Skipping non-image cover entry for ${wcProduct.name} (use handleProductMedia for videos)`,
        );
        return null;
      }

      this.logger.info(`📸 Processing cover image for: ${wcProduct.name}`);

      const uploadedImage = await this.downloadAndUploadImage(
        coverImageData.src,
        coverImageData.alt || wcProduct.name,
        `product-${wcProduct.id}-cover`,
        true,
      );

      if (uploadedImage) {
        this.logger.success(`✅ Cover image uploaded: ${uploadedImage.name}`);
        return uploadedImage.id;
      }

      return null;
    } catch (error) {
      this.logger.error(
        `❌ Failed to handle cover image for product ${wcProduct.id}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Download and upload gallery images (skips first image — legacy path)
   */
  async handleGalleryImages(wcProduct, strapiProductId, maxImages = 999) {
    try {
      if (!wcProduct.images || wcProduct.images.length <= 1) {
        this.logger.debug(`📸 No gallery images for product: ${wcProduct.name}`);
        return [];
      }

      const totalGalleryImages = wcProduct.images.length - 1;
      const imagesToProcess = Math.min(totalGalleryImages, maxImages);

      this.logger.info(
        `📸 Processing ${imagesToProcess}/${totalGalleryImages} gallery images for: ${
          wcProduct.name
        }${maxImages < 999 ? ` (max: ${maxImages})` : ""}`,
      );

      const uploadedImages = [];
      const allowedVideoTypes = this.getVideoConfig().allowedTypes || ["mp4", "webm", "mov", "m4v"];

      for (let i = 1; i < wcProduct.images.length && uploadedImages.length < maxImages; i++) {
        const imageData = wcProduct.images[i];
        if (!imageData.src) continue;

        const kind = detectMediaKind(imageData.src, undefined, allowedVideoTypes);
        if (kind !== "image") continue;

        const uploadedImage = await this.downloadAndUploadImage(
          imageData.src,
          imageData.alt || `${wcProduct.name} - Image ${i}`,
          `product-${wcProduct.id}-gallery-${i}`,
        );

        if (uploadedImage) {
          uploadedImages.push(uploadedImage.id);
          this.logger.debug(`✅ Gallery image ${i} uploaded: ${uploadedImage.name}`);
        }

        await this.delay(100);
      }

      this.logger.success(`✅ Uploaded ${uploadedImages.length} gallery images`);
      return uploadedImages;
    } catch (error) {
      this.logger.error(
        `❌ Failed to handle gallery images for product ${wcProduct.id}:`,
        error.message,
      );
      return [];
    }
  }

  /**
   * Upload a single media URL (auto-detects image vs video)
   */
  async downloadAndUploadMedia(mediaUrl, altText, prefix, isCover = false, sourceTimestamps = null) {
    const videoConfig = this.getVideoConfig();
    const kind = detectMediaKind(mediaUrl, undefined, videoConfig.allowedTypes || ["mp4", "webm", "mov", "m4v"]);

    if (kind === "embed") {
      if (videoConfig.skipEmbedUrls !== false) {
        this.logger.warn(
          `⚠️ ویدیوی تعبیه‌شده (YouTube/Vimeo) پشتیبانی نمی‌شود — source=${this.sourceHash(mediaUrl)}`,
        );
        return null;
      }
    }

    if (kind === "video") {
      if (videoConfig.enableUpload === false) {
        this.logger.debug(`⏭️ Video upload disabled — source=${this.sourceHash(mediaUrl)}`);
        return null;
      }
      return this.downloadAndUploadVideo(mediaUrl, altText, prefix, isCover, sourceTimestamps);
    }

    if (kind === "image") {
      return this.downloadAndUploadImage(mediaUrl, altText, prefix, isCover, sourceTimestamps);
    }

    this.logger.warn(`⚠️ نوع فایل پشتیبانی نمی‌شود — source=${this.sourceHash(mediaUrl)}`);
    return null;
  }

  async inspectAudio(audioUrl) {
    const audioConfig = this.getAudioConfig();
    const result = await this.downloadMediaWithRetry(
      audioUrl,
      audioConfig.downloadRetries || 3,
      "audio",
    );
    if (!result?.buffer) throw new Error("Audio download or validation failed");
    const contentType = String(result.contentType || "").toLowerCase();
    if (contentType !== "audio/mpeg" && contentType !== "audio/mp3") {
      throw new Error(`Invalid MP3 MIME type: ${contentType || "unknown"}`);
    }
    const buffer = result.buffer;
    const hasId3 = buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "ID3";
    const hasMpegFrame = buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
    if (!hasId3 && !hasMpegFrame) throw new Error("Audio payload is not a valid MP3 stream");
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    return {
      buffer,
      sha256,
      bytes: buffer.length,
      mime: "audio/mpeg",
      name: `wc-category-audio-${sha256}.mp3`,
    };
  }

  async uploadInspectedAudio(inspection, label) {
    if (!inspection?.buffer || !inspection?.sha256 || !inspection?.name) {
      throw new Error("Audio inspection is incomplete");
    }
    const audioConfig = this.getAudioConfig();
    return this.uploadToStrapiWithRetry(
      inspection.buffer,
      inspection.name,
      label,
      audioConfig.uploadRetries || 3,
      "audio",
      null,
    );
  }

  async downloadAndUploadImage(imageUrl, altText, prefix, isCoverImage = false, sourceTimestamps = null) {
    try {
      const retryConfig = this.getImageConfig().retry || {};
      const downloadRetries = isCoverImage
        ? retryConfig.coverImageDownloadRetries || 3
        : retryConfig.galleryImageDownloadRetries || 3;

      const imageBuffer = await this.downloadMediaWithRetry(imageUrl, downloadRetries, "image");
      if (!imageBuffer) return null;

      const { buffer: processedBuffer, fileName: processedFileName } = await this.processImage(
        imageBuffer,
        imageUrl,
        prefix,
      );

      const uploadRetries = isCoverImage
        ? retryConfig.coverImageUploadRetries || 3
        : retryConfig.galleryImageUploadRetries || 3;

      const uploadedImage = await this.uploadToStrapiWithRetry(
        processedBuffer,
        processedFileName,
        altText,
        uploadRetries,
        "image",
        sourceTimestamps,
      );

      return uploadedImage;
    } catch (error) {
      if (error.code === "MEDIA_DESTINATION_AMBIGUOUS") throw error;
      this.logger.error(`❌ Failed to process image source=${this.sourceHash(imageUrl)}:`, error.message);
      return null;
    }
  }

  async downloadAndUploadVideo(videoUrl, altText, prefix, isCoverVideo = false, sourceTimestamps = null) {
    try {
      if (isEmbedVideoUrl(videoUrl)) {
        this.logger.warn(
          `⚠️ ویدیوی تعبیه‌شده (YouTube/Vimeo) قابل دانلود نیست — source=${this.sourceHash(videoUrl)}`,
        );
        return null;
      }

      const videoConfig = this.getVideoConfig();
      const retryConfig = this.getImageConfig().retry || {};
      const downloadRetries = isCoverVideo
        ? retryConfig.coverImageDownloadRetries || 3
        : retryConfig.galleryImageDownloadRetries || 3;

      const downloadResult = await this.downloadMediaWithRetry(videoUrl, downloadRetries, "video");
      if (!downloadResult) return null;

      const { buffer, contentType } = downloadResult;
      const fileName = this.generateFileName(videoUrl, prefix, contentType);

      if (!this.isValidVideoFile(fileName, contentType)) {
        this.logger.error(
          `❌ فرمت ویدیو نامعتبر است — فقط ${(videoConfig.allowedTypes || []).join(", ")} مجاز است: source=${this.sourceHash(videoUrl)}`,
        );
        return null;
      }

      const uploadRetries = isCoverVideo
        ? retryConfig.coverImageUploadRetries || 3
        : retryConfig.galleryImageUploadRetries || 3;

      const uploadedVideo = await this.uploadToStrapiWithRetry(
        buffer,
        fileName,
        altText,
        uploadRetries,
        "video",
        sourceTimestamps,
      );

      if (uploadedVideo) this.logger.success(`✅ Video uploaded: ${uploadedVideo.name}`);

      return uploadedVideo;
    } catch (error) {
      if (error.code === "MEDIA_DESTINATION_AMBIGUOUS") throw error;
      this.logger.error(`❌ Failed to process video source=${this.sourceHash(videoUrl)}:`, error.message);
      return null;
    }
  }

  isValidVideoFile(fileName, contentType) {
    const videoConfig = this.getVideoConfig();
    const allowedTypes = videoConfig.allowedTypes || ["mp4", "webm", "mov", "m4v"];
    const ext = path.extname(fileName).slice(1).toLowerCase();

    if (contentType && contentType.startsWith("video/")) {
      return allowedTypes.some((type) => contentType.includes(type) || ext === type);
    }

    return allowedTypes.includes(ext);
  }

  async downloadMediaWithRetry(mediaUrl, maxRetries = 3, mediaKind = "image") {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.downloadMedia(mediaUrl, mediaKind);
        if (result) {
          return result;
        }
        throw new Error("Download returned null");
      } catch (error) {
        lastError = error;

        if (
          error.message?.includes("too large") ||
          error.message?.includes("HTTP 404") ||
          error.message?.includes("نامعتبر") ||
          (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 429)
        ) {
          this.logger.error(`❌ Non-retryable media error source=${this.sourceHash(mediaUrl)}:`, error.message);
          return null;
        }

        if (attempt === maxRetries) {
          break;
        }

        const retryConfig = this.getImageConfig().retry || {};
        const retryDelay = computeBackoffDelay(attempt, {
          baseDelay: retryConfig.initialRetryDelay || 1000,
          maxDelay: retryConfig.maxRetryDelay || 10000,
          factor: retryConfig.retryMultiplier || 2,
          jitter: true,
        });

        this.logger.warn(
          `🔄 Media download failed (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}ms: source=${this.sourceHash(mediaUrl)}`,
          error.message,
        );
        await this.delay(retryDelay);
      }
    }

    this.logger.error(
      `❌ Failed to download media after ${maxRetries} attempts: source=${this.sourceHash(mediaUrl)}`,
      lastError?.message,
    );
    return null;
  }

  /** @returns {Buffer | { buffer: Buffer, contentType: string } | null} */
  async downloadMedia(mediaUrl, mediaKind = "image") {
    const imageConfig = this.getImageConfig();
    const videoConfig = this.getVideoConfig();
    const audioConfig = this.getAudioConfig();
    const timeout = mediaKind === "video"
      ? videoConfig.downloadTimeout || 120000
      : mediaKind === "audio"
        ? audioConfig.downloadTimeout || 120000
        : imageConfig.downloadTimeout || 30000;
    const maxSize = mediaKind === "video"
      ? videoConfig.maxSize || 256 * 1024 * 1024
      : mediaKind === "audio"
        ? audioConfig.maxSize || 64 * 1024 * 1024
        : imageConfig.maxSize || 10 * 1024 * 1024;

    const sourceHash = this.sourceHash(mediaUrl);
    this.logger.debug(`📥 Downloading ${mediaKind}: source=${sourceHash}`);
    const started = process.hrtime.bigint();
    const response = await this.downloadFollowingSafeRedirects(mediaUrl, {
      timeout,
      maxRedirects: 5,
      maxBytes: maxSize,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = Buffer.from(response.data);
    const contentType = (response.headers["content-type"] || "").toLowerCase().split(";")[0].trim();

    if (!buffer.length) {
      throw new Error("Downloaded media payload is empty");
    }

    if (mediaKind === "video") {
      if (contentType && !contentType.startsWith("video/")) {
        throw new Error(`نوع MIME ویدیو نامعتبر است: ${contentType || "unknown"}`);
      }
    } else if (mediaKind === "audio") {
      if (contentType !== "audio/mpeg" && contentType !== "audio/mp3") {
        throw new Error(`Invalid MP3 MIME type: ${contentType || "unknown"}`);
      }
    } else if (mediaKind === "image") {
      if (contentType && !contentType.startsWith("image/")) {
        throw new Error(`نوع MIME تصویر نامعتبر است: ${contentType || "unknown"}`);
      }
      // Reject obvious HTML/error bodies even when Content-Type is missing/wrong.
      const head = buffer.subarray(0, Math.min(buffer.length, 256)).toString("utf8").trimStart().toLowerCase();
      if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml")) {
        throw new Error("Downloaded payload looks like HTML/XML, not an image");
      }
    }

    if (buffer.length > maxSize) {
      throw new Error(
        `${mediaKind === "video" ? "Video" : mediaKind === "audio" ? "Audio" : "Image"} too large: ${(buffer.length / 1024 / 1024).toFixed(2)}MB > ${(maxSize / 1024 / 1024).toFixed(2)}MB`,
      );
    }

    this.metrics.downloadBytes += buffer.length;
    this.metrics.downloadMs += Number(process.hrtime.bigint() - started) / 1e6;
    this.logger.debug(`✅ Downloaded ${(buffer.length / 1024).toFixed(2)}KB source=${sourceHash}`);
    return mediaKind === "video" || mediaKind === "audio" ? { buffer, contentType } : buffer;
  }

  /** @deprecated Use downloadMediaWithRetry */
  async downloadImageWithRetry(imageUrl, maxRetries = 3) {
    return this.downloadMediaWithRetry(imageUrl, maxRetries, "image");
  }

  /** @deprecated Use downloadMedia */
  async downloadImage(imageUrl) {
    return this.downloadMedia(imageUrl, "image");
  }

  async processImage(imageBuffer, imageUrl, prefix) {
    const started = process.hrtime.bigint();
    try {
      const metadata = await sharp(imageBuffer).metadata();
      const originalFormat = metadata.format;
      const originalSizeKb = (imageBuffer.length / 1024).toFixed(2);

      if (originalFormat === "gif") {
        this.logger.debug(`🎬 Keeping GIF as-is: ${this.generateFileName(imageUrl, prefix)}`);
        return {
          buffer: imageBuffer,
          fileName: this.generateFileName(imageUrl, prefix),
        };
      }

      this.logger.debug(`🔧 Converting ${originalFormat?.toUpperCase() || "UNKNOWN"} to WebP...`);

      const processedBuffer = await sharp(imageBuffer).webp({ quality: 85 }).toBuffer();
      const sharpCounters = sharp.counters();
      this.metrics.sharpQueuePeak = Math.max(this.metrics.sharpQueuePeak, sharpQueuePeak, sharpQueueDepth, sharpCounters.queue);
      this.metrics.sharpProcessPeak = Math.max(this.metrics.sharpProcessPeak, sharpCounters.process);

      let fileName = this.generateFileName(imageUrl, prefix);
      fileName = fileName.substring(0, fileName.lastIndexOf(".")) + ".webp";

      const newSizeKb = (processedBuffer.length / 1024).toFixed(2);
      const savings = (
        ((imageBuffer.length - processedBuffer.length) / imageBuffer.length) *
        100
      ).toFixed(1);

      if (processedBuffer.length >= imageBuffer.length) {
        this.logger.debug(
          `WebP conversion skipped: ${originalFormat?.toUpperCase() || "UNKNOWN"} original is smaller (${originalSizeKb}KB <= ${newSizeKb}KB)`,
        );
        return {
          buffer: imageBuffer,
          fileName: this.generateFileName(imageUrl, prefix),
        };
      }

      this.logger.success(
        `✅ Converted to WebP: ${originalFormat?.toUpperCase() || "UNKNOWN"} → ${fileName} (${originalSizeKb}KB → ${newSizeKb}KB, ${savings}% savings)`,
      );

      return {
        buffer: processedBuffer,
        fileName,
      };
    } catch (error) {
      this.logger.error(`❌ Failed to convert image to WebP:`, error.message);
      // Do not upload unverified/non-image payloads. Require sharp to parse the buffer.
      throw new Error(`Image payload failed validation/processing: ${error.message}`);
    } finally {
      this.metrics.conversionMs += Number(process.hrtime.bigint() - started) / 1e6;
    }
  }

  async uploadToStrapiWithRetry(
    fileBuffer,
    fileName,
    altText,
    maxRetries = 3,
    mediaKind = "image",
    sourceTimestamps = null,
  ) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const existing = await this.findExactDestinationFile(fileName);
        if (existing) return { ...existing, _reusedDeterministic: true };
        const started = process.hrtime.bigint();
        const uploadedFile = await this.uploadToStrapi(fileBuffer, fileName, altText, sourceTimestamps);
        this.metrics.uploadMs += Number(process.hrtime.bigint() - started) / 1e6;
        if (uploadedFile) {
          return uploadedFile;
        }
        throw new Error("Upload returned null");
      } catch (error) {
        lastError = error;

        try {
          const recovered = await this.findExactDestinationFile(fileName);
          if (recovered) return { ...recovered, _reusedDeterministic: true };
        } catch (lookupError) {
          if (lookupError.code === "MEDIA_DESTINATION_AMBIGUOUS") throw lookupError;
        }

        if (
          error.response?.status === 401 ||
          error.response?.status === 403 ||
          (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 429)
        ) {
          this.logger.error(`❌ Non-retryable error for ${mediaKind} upload:`, error.message);
          if (error.response?.data) {
            this.logger.error(`Strapi response:`, error.response.data);
          }
          return null;
        }

        if (attempt === maxRetries) {
          break;
        }

        const retryConfig = this.getImageConfig().retry || {};
        const retryDelay = computeBackoffDelay(attempt, {
          baseDelay: retryConfig.initialRetryDelay || 1000,
          maxDelay: retryConfig.maxRetryDelay || 10000,
          factor: retryConfig.retryMultiplier || 2,
          jitter: true,
        });

        this.logger.warn(
          `🔄 ${mediaKind} upload failed (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}ms: ${fileName}`,
          error.message,
        );
        await this.delay(retryDelay);
      }
    }

    this.logger.error(
      `❌ Failed to upload ${mediaKind} after ${maxRetries} attempts: ${fileName}`,
      lastError?.message,
    );
    if (lastError?.response?.data) {
      this.logger.error(`Strapi response:`, lastError.response.data);
    }
    return null;
  }

  async uploadToStrapi(fileBuffer, fileName, altText, sourceTimestamps = null) {
    const form = new FormData();

    form.append("files", fileBuffer, {
      filename: fileName,
      contentType: this.getContentType(fileName),
    });

    form.append(
      "fileInfo",
      JSON.stringify({
        alternativeText: altText,
        caption: altText,
      }),
    );

    const uploadHeaders = { ...form.getHeaders() };
    const strapiConfig = this.getStrapiConfig();
    if (!strapiConfig.usePublicAccess && strapiConfig.auth?.token) {
      uploadHeaders.Authorization = `Bearer ${strapiConfig.auth.token}`;
    }
    if (this.config.migration?.controlToken) {
      uploadHeaders["X-Infinity-Migration-Mode"] = "wordpress-v2";
      uploadHeaders["X-Infinity-Migration-Control"] = this.config.migration.controlToken;
      Object.assign(uploadHeaders, sourceTimestampHeaders(sourceTimestamps));
    }

    const imageConfig = this.getImageConfig();
    const videoConfig = this.getVideoConfig();
    const contentType = this.getContentType(fileName);
    const isVideo = contentType.startsWith("video/");
    const isAudio = contentType.startsWith("audio/");
    const audioConfig = this.getAudioConfig();
    const uploadTimeout = isVideo
      ? videoConfig.uploadTimeout || 120000
      : isAudio
        ? audioConfig.uploadTimeout || 120000
        : imageConfig.uploadTimeout || 60000;

    const response = await axios.post(`${strapiConfig.baseUrl}/upload`, form, {
      headers: uploadHeaders,
      timeout: uploadTimeout,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    if (response.data && response.data.length > 0) {
      const uploadedFile = response.data[0];
      this.logger.debug(`✅ Uploaded to Strapi: ${uploadedFile.name} (ID: ${uploadedFile.id})`);
      return uploadedFile;
    }

    throw new Error("No file data returned from Strapi");
  }

  generateFileName(mediaUrl, prefix, contentTypeHint = "") {
    const extFromMime = () => {
      const mime = contentTypeHint.toLowerCase();
      if (mime.includes("mp4")) return ".mp4";
      if (mime.includes("webm")) return ".webm";
      if (mime.includes("quicktime") || mime.includes("mov")) return ".mov";
      return "";
    };

    try {
      const url = new URL(canonicalSourceUrl(mediaUrl));
      const originalName = path.basename(url.pathname);
      const ext = (path.extname(originalName) || extFromMime() || ".jpg").toLowerCase();
      return `wc-src-${this.sourceHash(mediaUrl)}${ext}`;
    } catch {
      return `wc-src-${this.sourceHash(mediaUrl)}${extFromMime() || ".jpg"}`;
    }
  }

  sourceHash(mediaUrl) {
    let canonical;
    try { canonical = canonicalSourceUrl(mediaUrl); } catch { canonical = String(mediaUrl); }
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  async findExactDestinationFile(fileName) {
    const strapiConfig = this.getStrapiConfig();
    const headers = {};
    if (!strapiConfig.usePublicAccess && strapiConfig.auth?.token) headers.Authorization = `Bearer ${strapiConfig.auth.token}`;
    const response = await axios.get(`${strapiConfig.baseUrl}/upload/files`, {
      headers,
      timeout: 30_000,
      params: { "filters[name][$eq]": fileName, "pagination[pageSize]": 2 },
    });
    const rows = Array.isArray(response.data) ? response.data : response.data?.data || [];
    if (rows.length > 1) {
      const error = new Error(`Ambiguous deterministic destination filename: ${fileName}`);
      error.code = "MEDIA_DESTINATION_AMBIGUOUS";
      throw error;
    }
    return rows[0] || null;
  }

  /**
   * Confirm a previously mapped Strapi file id still exists.
   * @param {number|string} mediaId
   * @returns {Promise<object|null>}
   */
  async findDestinationFileById(mediaId) {
    if (mediaId === undefined || mediaId === null || mediaId === "") return null;
    const strapiConfig = this.getStrapiConfig();
    const headers = {};
    if (!strapiConfig.usePublicAccess && strapiConfig.auth?.token) headers.Authorization = `Bearer ${strapiConfig.auth.token}`;
    try {
      const response = await axios.get(`${strapiConfig.baseUrl}/upload/files/${mediaId}`, {
        headers,
        timeout: 30_000,
        validateStatus: (status) => status === 200 || status === 404,
      });
      if (response.status === 404) return null;
      return response.data || null;
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async assertSafeRemoteUrl(rawUrl) {
    const check = validateMediaUrl(rawUrl, { allowHttp: Boolean(this.config.catalog?.allowHttpMedia) });
    if (!check.ok) throw new Error(`Unsafe media URL blocked: ${check.reason}`);
    const addresses = await dns.lookup(check.url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => isPrivateHost(entry.address))) {
      throw new Error("Unsafe media URL blocked: DNS resolved to private/reserved address");
    }
    return { url: check.url.toString(), address: addresses[0].address, family: addresses[0].family };
  }

  async downloadFollowingSafeRedirects(rawUrl, { timeout, maxRedirects, maxBytes = Infinity }) {
    let current = rawUrl;
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const safe = await this.assertSafeRemoteUrl(current);
      const response = await axios({
        method: "GET",
        url: safe.url,
        responseType: "arraybuffer",
        timeout,
        maxRedirects: 0,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        validateStatus: (status) => status >= 200 && status < 400,
        lookup: (_hostname, _options, callback) => callback(null, safe.address, safe.family),
        headers: { "User-Agent": "WooCommerce-Strapi-Importer/2.0.0" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        if (!location || redirect === maxRedirects) throw new Error("Media redirect limit exceeded");
        current = new URL(location, safe.url).toString();
        continue;
      }
      return response;
    }
    throw new Error("Media redirect limit exceeded");
  }

  getContentType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const contentTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".m4v": "video/mp4",
      ".ogv": "video/ogg",
      ".mp3": "audio/mpeg",
    };
    return contentTypes[ext] || "application/octet-stream";
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
      this.logger.debug(`📁 Created temp directory: ${this.tempDir}`);
    }
  }

  cleanup() {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        for (const file of files) {
          const filePath = path.join(this.tempDir, file);
          if (fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
          }
        }
      }

      this.logger.debug("🧹 Media uploader cleanup completed");
    } catch (error) {
      this.logger.error("❌ Error during cleanup:", error.message);
    }
  }

  getStats() {
    return {
      ...this.metrics,
      sharp: { cache: sharp.cache(), counters: sharp.counters(), queueDepth: sharpQueueDepth, queuePeak: sharpQueuePeak },
    };
  }

  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = ImageUploader;
